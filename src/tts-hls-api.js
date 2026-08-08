import { jsonResponse } from './http.js';
import { splitArticleParagraphs } from '../public/lib/text.js';
import { handleTtsApi, isTtsProfile, ttsCacheIdentity } from './tts-api.js';
import {
  createMediaPlaylist,
  parseMp3Duration,
  prependTransportTimestamp
} from './hls-audio.js';

const HLS_VERSION = 'v1';
const HLS_MIME = 'application/vnd.apple.mpegurl';
// Azure synthesis retries up to three times, so 15 sentences remain below the
// Workers Free plan's 50 external-subrequest ceiling even under throttling.
const PREPARE_BATCH_SIZE = 15;

export async function handleTtsHlsApi(
  request,
  env,
  path,
  userId,
  runtime = {}
) {
  if (request.method !== 'GET') return notFound();
  const route = parseRoute(path);
  if (!route) return notFound();
  const profile = new URL(request.url).searchParams.get('profile') || 'aria-narration';
  if (!isTtsProfile(profile)) {
    return jsonResponse(
      { error: 'invalid TTS profile', code: 'INVALID_TTS_PROFILE' },
      { status: 400 }
    );
  }
  const article = await loadArticle(env.DB, route.articleId, userId);
  if (!article) return notFound('ARTICLE_NOT_FOUND');
  const fingerprint = await articleHlsFingerprint({ body: article.body, profile });
  const url = new URL(request.url);

  if (route.kind !== 'prepare' && url.searchParams.get('v') !== fingerprint) {
    return conflict('HLS_ARTICLE_CHANGED');
  }

  if (route.kind === 'segment') {
    return segmentResponse({
      request,
      env,
      userId,
      runtime,
      article,
      articleId: route.articleId,
      index: route.index,
      profile,
      fingerprint
    });
  }

  if (route.kind === 'prepare') {
    return prepareResponse({
      request,
      env,
      userId,
      runtime,
      article,
      articleId: route.articleId,
      profile,
      fingerprint
    });
  }

  const prepared = await loadPreparedTimeline(env.AUDIO, fingerprint);
  if (!prepared) return notFound('HLS_NOT_PREPARED');

  const playlist = createMediaPlaylist({
    segments: prepared.timeline.map(sentence => ({
      durationSeconds: sentence.durationSeconds,
      url: segmentUrl(
        route.articleId,
        sentence.index,
        profile,
        fingerprint,
        sentence.fingerprint,
        Math.round(sentence.startSeconds * 90000)
      )
    }))
  });
  return new Response(playlist, {
    headers: {
      'content-type': HLS_MIME,
      'cache-control': 'private, no-cache'
    }
  });
}

async function prepareResponse(options) {
  const url = new URL(options.request.url);
  const cursorText = url.searchParams.get('cursor') || '0';
  if (!/^\d+$/.test(cursorText)) {
    return jsonResponse(
      { error: 'invalid HLS cursor', code: 'INVALID_HLS_CURSOR' },
      { status: 400 }
    );
  }
  const cursor = Number(cursorText);
  const sentenceCount = splitArticleParagraphs(options.article.body).sentences.length;
  if (!sentenceCount) return notFound('TTS_TEXT_EMPTY');
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= sentenceCount) {
    return jsonResponse(
      { error: 'invalid HLS cursor', code: 'INVALID_HLS_CURSOR' },
      { status: 400 }
    );
  }
  const end = Math.min(sentenceCount, cursor + PREPARE_BATCH_SIZE);
  const batch = await prepareArticle({ ...options, start: cursor, end });
  if (batch instanceof Response) return batch;
  if (end < sentenceCount) {
    return jsonResponse(
      { ready: false, nextCursor: end },
      { status: 202, headers: { 'cache-control': 'private, no-store' } }
    );
  }

  const prepared = await prepareArticle({ ...options, cacheOnly: true });
  if (prepared instanceof Response) return prepared;
  await storePreparedTimeline(options.env.AUDIO, options.fingerprint, prepared);
  return jsonResponse({
    ready: true,
    playlistUrl: playlistUrl(options.articleId, options.profile, options.fingerprint),
    fingerprint: options.fingerprint,
    sentences: publicTimeline(prepared.timeline),
    durationSeconds: prepared.durationSeconds
  }, {
    headers: { 'cache-control': 'private, no-store' }
  });
}

export async function articleHlsFingerprint({ body, profile }) {
  return sha256Hex(JSON.stringify({
    version: HLS_VERSION,
    tts: ttsCacheIdentity(),
    body,
    profile
  }));
}

async function prepareArticle({
  request,
  env,
  userId,
  runtime,
  article,
  articleId,
  profile,
  fingerprint,
  start = 0,
  end = null,
  cacheOnly = false
}) {
  const sentences = splitArticleParagraphs(article.body).sentences;
  if (!sentences.length) return notFound('TTS_TEXT_EMPTY');
  const selected = sentences.slice(start, end == null ? sentences.length : end);
  const results = await mapBounded(selected, 3, async sentence => {
    const path = sentencePath(articleId, sentence.index);
    const speechUrl = new URL(path, request.url);
    speechUrl.searchParams.set('profile', profile);
    const response = await fetchPreparedSentence({
      request: new Request(speechUrl, { headers: request.headers }),
      env,
      path,
      userId,
      runtime,
      cacheOnly
    });
    if (!response.ok) return { response };
    const bytes = new Uint8Array(await response.arrayBuffer());
    let parsed;
    try {
      parsed = parseMp3Duration(bytes);
    } catch {
      return {
        response: jsonResponse(
          { error: 'invalid synthesized audio', code: 'HLS_INVALID_AUDIO' },
          { status: 503 }
        )
      };
    }
    const cacheKey = response.headers.get('x-tts-cache-key');
    if (!cacheKey) {
      return {
        response: jsonResponse(
          { error: 'prepared audio cache key missing', code: 'HLS_CACHE_KEY_MISSING' },
          { status: 503 }
        )
      };
    }
    const sentenceFingerprint = await sha256Hex(JSON.stringify({
      article: fingerprint,
      index: sentence.index,
      text: sentence.text
    }));
    return {
      index: sentence.index,
      durationSeconds: parsed.durationSeconds,
      fingerprint: sentenceFingerprint,
      cacheKey
    };
  });
  const failure = results.find(result => result.response);
  if (failure) return failure.response;

  let startSeconds = 0;
  const timeline = results.map(result => {
    const entry = { ...result, startSeconds };
    startSeconds += result.durationSeconds;
    return entry;
  });
  return { timeline, durationSeconds: startSeconds };
}

async function fetchPreparedSentence({ request, env, path, userId, runtime, cacheOnly }) {
  let response = await handleTtsApi(
    request,
    env,
    path,
    userId,
    cacheOnly ? { ...runtime, cacheOnly: true } : runtime
  );
  if (cacheOnly || !await responseHasCode(response, 'TTS_GENERATION_BUSY')) return response;

  const sleep = runtime.sleep || (milliseconds => new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  }));
  for (let attempt = 0; attempt < 35; attempt += 1) {
    await sleep(Math.min(100 * (2 ** attempt), 1000));
    response = await handleTtsApi(
      request,
      env,
      path,
      userId,
      { ...runtime, cacheOnly: true }
    );
    if (response.ok) return response;
    if (!await responseHasCode(response, 'TTS_NOT_PREPARED')) return response;
  }
  return response;
}

async function responseHasCode(response, code) {
  if (!response || response.headers.get('content-type')?.includes('application/json') !== true) {
    return false;
  }
  try {
    return (await response.clone().json()).code === code;
  } catch {
    return false;
  }
}

async function segmentResponse({
  request,
  env,
  userId,
  runtime,
  article,
  articleId,
  index,
  profile,
  fingerprint
}) {
  const prepared = await loadPreparedTimeline(env.AUDIO, fingerprint);
  if (!prepared) return notFound('HLS_NOT_PREPARED');
  const sentence = prepared.timeline[index];
  if (!sentence || sentence.index !== index) return notFound('SENTENCE_NOT_FOUND');
  const url = new URL(request.url);
  if (url.searchParams.get('s') !== sentence.fingerprint) {
    return conflict('HLS_SENTENCE_CHANGED');
  }
  const ticksValue = url.searchParams.get('t');
  if (!/^\d+$/.test(ticksValue || '')) {
    return jsonResponse(
      { error: 'invalid HLS timestamp', code: 'INVALID_HLS_TIMESTAMP' },
      { status: 400 }
    );
  }
  const expectedTicks = Math.round(sentence.startSeconds * 90000);
  if (BigInt(ticksValue) !== BigInt(expectedTicks)) {
    return conflict('HLS_TIMESTAMP_CHANGED');
  }
  const cached = await env.AUDIO?.get(sentence.cacheKey);
  if (!cached) return notFound('HLS_SEGMENT_NOT_PREPARED');
  const bytes = new Uint8Array(await new Response(cached.body ?? cached).arrayBuffer());
  const packed = prependTransportTimestamp(bytes, BigInt(expectedTicks));
  return new Response(packed, {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, max-age=31536000, immutable'
    }
  });
}

function parseRoute(path) {
  let match = path.match(/^\/api\/tts\/articles\/([a-zA-Z0-9-]+)\/hls\/prepare$/);
  if (match) return { kind: 'prepare', articleId: match[1] };
  match = path.match(/^\/api\/tts\/articles\/([a-zA-Z0-9-]+)\/hls\/stream\.m3u8$/);
  if (match) return { kind: 'playlist', articleId: match[1] };
  match = path.match(
    /^\/api\/tts\/articles\/([a-zA-Z0-9-]+)\/hls\/segments\/(\d+)\.mp3$/
  );
  if (match) return { kind: 'segment', articleId: match[1], index: Number(match[2]) };
  return null;
}

async function loadArticle(DB, articleId, userId) {
  return DB.prepare(`
    SELECT body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
}

function sentencePath(articleId, index) {
  return `/api/tts/articles/${encodeURIComponent(articleId)}/sentences/${index}`;
}

function playlistUrl(articleId, profile, fingerprint) {
  return `/api/tts/articles/${encodeURIComponent(articleId)}/hls/stream.m3u8`
    + `?profile=${encodeURIComponent(profile)}&v=${encodeURIComponent(fingerprint)}`;
}

function segmentUrl(articleId, index, profile, articleFingerprint, sentenceFingerprint, ticks) {
  return `/api/tts/articles/${encodeURIComponent(articleId)}/hls/segments/${index}.mp3`
    + `?profile=${encodeURIComponent(profile)}`
    + `&v=${encodeURIComponent(articleFingerprint)}`
    + `&s=${encodeURIComponent(sentenceFingerprint)}`
    + `&t=${ticks}`;
}

function preparedTimelineKey(fingerprint) {
  return `hls/${fingerprint}.json`;
}

async function storePreparedTimeline(bucket, fingerprint, prepared) {
  await bucket.put(
    preparedTimelineKey(fingerprint),
    JSON.stringify(prepared),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

async function loadPreparedTimeline(bucket, fingerprint) {
  const object = await bucket?.get(preparedTimelineKey(fingerprint));
  if (!object) return null;
  try {
    const value = JSON.parse(await new Response(object.body ?? object).text());
    if (!Array.isArray(value?.timeline) || !Number.isFinite(value?.durationSeconds)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function publicTimeline(timeline) {
  return timeline.map(({ index, startSeconds, durationSeconds }) => ({
    index,
    startSeconds,
    durationSeconds
  }));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function mapBounded(values, concurrency, worker) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await worker(values[index]);
      }
    }
  ));
  return results;
}

function conflict(code) {
  return jsonResponse({ error: 'HLS source changed', code }, { status: 409 });
}

function notFound(code = 'NOT_FOUND') {
  return jsonResponse({ error: 'not found', code }, { status: 404 });
}
