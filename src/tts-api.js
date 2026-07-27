import { jsonResponse } from './http.js';
import { splitSentences } from '../public/lib/text.js';

const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const CACHE_VERSION = 'v1';

export async function handleTtsApi(
  request,
  env,
  path,
  userId,
  runtime = {}
) {
  const now = runtime.now || (() => new Date());
  if (path === '/api/tts/usage' && request.method === 'GET') {
    return usageResponse(env, userId, now());
  }
  if (request.method !== 'GET') return notFound();

  const resource = await resolveResource(request, env.DB, path, userId);
  if (resource instanceof Response) return resource;
  const text = normalizeSpeechText(resource.text);
  if (!text) {
    return jsonResponse(
      { error: 'nothing to synthesize', code: 'TTS_TEXT_EMPTY' },
      { status: 404 }
    );
  }

  const voice = env.AZURE_TTS_VOICE || 'en-US-JennyNeural';
  const cacheKey = await audioCacheKey(resource.mode, text, voice);
  const cached = await env.AUDIO?.get(cacheKey);
  if (cached) return cachedAudio(cached, 'hit');

  if (!env.AUDIO || !env.AZURE_TTS_KEY || !env.AZURE_TTS_REGION) {
    return unavailable('TTS_NOT_CONFIGURED');
  }

  const reviewedAt = now();
  const characterCount = Array.from(text).length;
  const lease = await acquireLease(
    env.DB, userId, cacheKey, characterCount,
    monthlyBudget(env), reviewedAt
  );
  if (!lease.ok) return unavailable(lease.code);

  let audio;
  try {
    audio = await synthesizeAzure(text, env, runtime.fetch || fetch);
  } catch (error) {
    await releaseLease(env.DB, lease, reviewedAt.getTime());
    return unavailable(error.code || 'TTS_GENERATION_FAILED');
  }

  await commitLease(env.DB, lease, reviewedAt.getTime());
  try {
    await env.AUDIO.put(cacheKey, audio, {
      httpMetadata: { contentType: 'audio/mpeg' }
    });
  } catch {
    return unavailable('TTS_CACHE_WRITE_FAILED');
  }
  return new Response(audio, {
    headers: audioHeaders('miss')
  });
}

async function resolveResource(request, DB, path, userId) {
  const wordMatch = path.match(/^\/api\/tts\/words\/([a-zA-Z0-9-]+)$/);
  if (wordMatch) {
    const mode = new URL(request.url).searchParams.get('mode') || 'word';
    if (!['word', 'example', 'spell'].includes(mode)) {
      return jsonResponse(
        { error: 'invalid TTS mode', code: 'INVALID_TTS_MODE' },
        { status: 400 }
      );
    }
    const word = await DB.prepare(`
      SELECT lemma, en, example FROM words WHERE id = ? AND user_id = ?
    `).bind(wordMatch[1], userId).first();
    if (!word) return notFound('WORD_NOT_FOUND');
    const source = word.lemma || word.en;
    return {
      mode,
      text: mode === 'example'
        ? word.example
        : mode === 'spell'
          ? Array.from(source || '').join('. ')
          : source
    };
  }

  const articleMatch = path.match(
    /^\/api\/tts\/articles\/([a-zA-Z0-9-]+)\/sentences\/(\d+)$/
  );
  if (!articleMatch) return notFound();
  const article = await DB.prepare(`
    SELECT body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleMatch[1], userId).first();
  if (!article) return notFound('ARTICLE_NOT_FOUND');
  const sentence = splitSentences(article.body)[Number(articleMatch[2])];
  if (!sentence) return notFound('SENTENCE_NOT_FOUND');
  return { mode: 'sentence', text: sentence.text };
}

async function acquireLease(DB, userId, cacheKey, characterCount, budget, date) {
  const month = date.toISOString().slice(0, 7);
  const now = date.getTime();
  const existing = await DB.prepare(`
    SELECT user_id, month, character_count, lease_until
    FROM tts_generation_leases WHERE cache_key = ?
  `).bind(cacheKey).first();
  if (existing && Number(existing.lease_until) <= now) {
    await DB.batch([
      DB.prepare(`
        DELETE FROM tts_generation_leases
        WHERE cache_key = ? AND lease_until <= ?
      `).bind(cacheKey, now),
      DB.prepare(`
        UPDATE tts_monthly_usage
        SET reserved_chars = MAX(0, reserved_chars - ?), updated_at = ?
        WHERE user_id = ? AND month = ?
          AND changes() = 1
      `).bind(
        existing.character_count, now, existing.user_id, existing.month
      )
    ]);
  } else if (existing) {
    return { ok: false, code: 'TTS_GENERATION_BUSY' };
  }

  const token = crypto.randomUUID();
  const results = await DB.batch([
    DB.prepare(`
      INSERT OR IGNORE INTO tts_monthly_usage
        (user_id, month, used_chars, reserved_chars, updated_at)
      VALUES (?, ?, 0, 0, ?)
    `).bind(userId, month, now),
    DB.prepare(`
      INSERT OR IGNORE INTO tts_generation_leases
        (cache_key, user_id, month, token, character_count, lease_until, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM tts_monthly_usage
        WHERE user_id = ? AND month = ?
          AND used_chars + reserved_chars + ? <= ?
      )
    `).bind(
      cacheKey, userId, month, token, characterCount, now + 30_000, now,
      userId, month, characterCount, budget
    ),
    DB.prepare(`
      UPDATE tts_monthly_usage
      SET reserved_chars = reserved_chars + ?, updated_at = ?
      WHERE user_id = ? AND month = ?
        AND EXISTS (
          SELECT 1 FROM tts_generation_leases
          WHERE cache_key = ? AND token = ?
        )
    `).bind(characterCount, now, userId, month, cacheKey, token)
  ]);
  if (!results[1].meta.changes) {
    const usage = await DB.prepare(`
      SELECT used_chars, reserved_chars FROM tts_monthly_usage
      WHERE user_id = ? AND month = ?
    `).bind(userId, month).first();
    return {
      ok: false,
      code: Number(usage?.used_chars || 0) + Number(usage?.reserved_chars || 0)
        + characterCount > budget
        ? 'TTS_BUDGET_EXCEEDED'
        : 'TTS_GENERATION_BUSY'
    };
  }
  return { ok: true, cacheKey, token, userId, month, characterCount };
}

async function commitLease(DB, lease, now) {
  await DB.batch([
    DB.prepare(`
      UPDATE tts_monthly_usage
      SET used_chars = used_chars + ?,
          reserved_chars = MAX(0, reserved_chars - ?),
          updated_at = ?
      WHERE user_id = ? AND month = ?
        AND EXISTS (
          SELECT 1 FROM tts_generation_leases
          WHERE cache_key = ? AND token = ?
        )
    `).bind(
      lease.characterCount, lease.characterCount, now,
      lease.userId, lease.month, lease.cacheKey, lease.token
    ),
    DB.prepare(`
      DELETE FROM tts_generation_leases WHERE cache_key = ? AND token = ?
    `).bind(lease.cacheKey, lease.token)
  ]);
}

async function releaseLease(DB, lease, now) {
  await DB.batch([
    DB.prepare(`
      UPDATE tts_monthly_usage
      SET reserved_chars = MAX(0, reserved_chars - ?), updated_at = ?
      WHERE user_id = ? AND month = ?
        AND EXISTS (
          SELECT 1 FROM tts_generation_leases
          WHERE cache_key = ? AND token = ?
        )
    `).bind(
      lease.characterCount, now, lease.userId, lease.month,
      lease.cacheKey, lease.token
    ),
    DB.prepare(`
      DELETE FROM tts_generation_leases WHERE cache_key = ? AND token = ?
    `).bind(lease.cacheKey, lease.token)
  ]);
}

async function synthesizeAzure(text, env, fetchImpl) {
  const endpoint = `https://${env.AZURE_TTS_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${escapeXml(env.AZURE_TTS_VOICE || 'en-US-JennyNeural')}">${escapeXml(text)}</voice></speak>`;
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/ssml+xml',
        'ocp-apim-subscription-key': env.AZURE_TTS_KEY,
        'x-microsoft-outputformat': OUTPUT_FORMAT,
        'user-agent': 'phonetic-cards-worker'
      },
      body: ssml
    });
    if (response.status !== 429) break;
  }
  if (!response?.ok) {
    const error = new Error('Azure TTS failed');
    error.code = response?.status === 429 ? 'TTS_RATE_LIMITED' : 'TTS_GENERATION_FAILED';
    throw error;
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function usageResponse(env, userId, date) {
  const month = date.toISOString().slice(0, 7);
  const row = await env.DB.prepare(`
    SELECT used_chars, reserved_chars FROM tts_monthly_usage
    WHERE user_id = ? AND month = ?
  `).bind(userId, month).first();
  return jsonResponse({
    month,
    usedChars: Number(row?.used_chars || 0),
    reservedChars: Number(row?.reserved_chars || 0),
    budget: monthlyBudget(env),
    configured: Boolean(
      env.AUDIO && env.AZURE_TTS_KEY && env.AZURE_TTS_REGION
    )
  });
}

function cachedAudio(cached, cacheState) {
  return new Response(cached.body ?? cached, {
    headers: audioHeaders(cacheState)
  });
}

function audioHeaders(cacheState) {
  return {
    'content-type': 'audio/mpeg',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-tts-cache': cacheState
  };
}

function unavailable(code) {
  return jsonResponse(
    { error: 'cloud speech unavailable; use browser speech', code, fallback: 'web-speech' },
    { status: 503 }
  );
}

function notFound(code = 'NOT_FOUND') {
  return jsonResponse({ error: 'not found', code }, { status: 404 });
}

function monthlyBudget(env) {
  const value = Number.parseInt(env.TTS_MONTHLY_CHAR_BUDGET || '450000', 10);
  return Number.isInteger(value) && value >= 0 ? value : 450000;
}

function normalizeSpeechText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function audioCacheKey(mode, text, voice) {
  const input = JSON.stringify({
    cacheVersion: CACHE_VERSION,
    mode,
    text,
    voice,
    outputFormat: OUTPUT_FORMAT
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return `${CACHE_VERSION}/${hex(digest)}.mp3`;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}
