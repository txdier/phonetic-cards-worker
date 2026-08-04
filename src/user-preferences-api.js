import { jsonResponse } from './http.js';

const TTS_PROFILES = new Set([
  'jenny-chat',
  'jenny-friendly',
  'aria-narration',
  'guy-news'
]);

export async function handleUserPreferencesApi(request, env, path, userId) {
  if (path !== '/api/user-preferences') {
    return jsonResponse({ error: 'not found' }, { status: 404 });
  }

  if (request.method === 'GET') {
    const row = await env.DB.prepare(`
      SELECT tts_preferences_json, updated_at
      FROM user_preferences WHERE user_id = ?
    `).bind(userId).first();
    return jsonResponse({
      ttsPreferences: parsePreferences(row?.tts_preferences_json),
      updatedAt: Number(row?.updated_at || 0)
    });
  }

  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { body = null; }
    const preferences = body?.ttsPreferences;
    if (!validPreferences(preferences)) {
      return jsonResponse(
        { error: 'invalid TTS preferences', code: 'INVALID_TTS_PREFERENCES' },
        { status: 400 }
      );
    }
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO user_preferences(user_id, tts_preferences_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        tts_preferences_json = excluded.tts_preferences_json,
        updated_at = excluded.updated_at
    `).bind(userId, JSON.stringify(preferences), now).run();
    return jsonResponse({
      ttsPreferences: { ...preferences },
      updatedAt: now
    });
  }

  return jsonResponse({ error: 'method not allowed' }, { status: 405 });
}

function parsePreferences(value) {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return validPreferences(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validPreferences(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 2
    && TTS_PROFILES.has(value.wordProfile)
    && TTS_PROFILES.has(value.articleProfile)
  );
}
