import { jsonResponse } from './http.js';

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
    if (!body || typeof body.ttsPreferences !== 'object') {
      return jsonResponse({ error: 'invalid preferences' }, { status: 400 });
    }
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO user_preferences(user_id, tts_preferences_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        tts_preferences_json = excluded.tts_preferences_json,
        updated_at = excluded.updated_at
    `).bind(userId, JSON.stringify(body.ttsPreferences), now).run();
    return jsonResponse({ updatedAt: now });
  }

  return jsonResponse({ error: 'method not allowed' }, { status: 405 });
}

function parsePreferences(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}
