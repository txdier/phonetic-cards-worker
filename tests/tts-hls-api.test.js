import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTtsHlsApi } from '../src/tts-hls-api.js';
import { parseMp3Duration } from '../src/hls-audio.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('HLS prepare creates an exact cached sentence timeline without duplicate synthesis', async t => {
  const env = seededEnv();
  t.after(() => env.DB.close());
  let azureCalls = 0;
  const runtime = {
    fetch: async () => {
      azureCalls += 1;
      return new Response(mp3Frames(2));
    }
  };

  const response = await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.sentences.length, 2);
  assert.deepEqual(payload.sentences.map(item => item.index), [0, 1]);
  assert.equal(payload.sentences[0].startSeconds, 0);
  assert.equal(payload.sentences[0].durationSeconds, 1152 / 24000);
  assert.equal(payload.sentences[1].startSeconds, 1152 / 24000);
  assert.equal(payload.durationSeconds, 2304 / 24000);
  assert.match(payload.playlistUrl, /\/hls\/stream\.m3u8\?profile=aria-narration&v=/);
  assert.equal(azureCalls, 2);

  const again = await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime);
  assert.equal(again.status, 200);
  assert.equal(azureCalls, 2);
});

test('HLS playlist validates its article fingerprint and emits timestamped segments', async t => {
  const env = seededEnv();
  t.after(() => env.DB.close());
  const runtime = { fetch: async () => new Response(mp3Frames(1)) };
  const prepared = await (
    await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime)
  ).json();

  const playlistResponse = await callHls(env, prepared.playlistUrl, runtime);
  const playlist = await playlistResponse.text();

  assert.equal(playlistResponse.status, 200);
  assert.equal(playlistResponse.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.match(playlistResponse.headers.get('cache-control'), /private, no-cache/);
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist, /\/hls\/segments\/0\.mp3\?profile=aria-narration&v=[^&]+&s=[^&]+&t=0/);
  assert.match(playlist, /\/hls\/segments\/1\.mp3\?profile=aria-narration&v=[^&]+&s=[^&]+&t=2160/);

  const stale = await callHls(
    env,
    '/api/tts/articles/a1/hls/stream.m3u8?profile=aria-narration&v=stale',
    runtime
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'HLS_ARTICLE_CHANGED');
});

test('HLS segment validates fingerprints and prepends its Packed Audio timestamp', async t => {
  const env = seededEnv();
  t.after(() => env.DB.close());
  const runtime = { fetch: async () => new Response(mp3Frames(1)) };
  const prepared = await (
    await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime)
  ).json();
  const playlist = await (
    await callHls(env, prepared.playlistUrl, runtime)
  ).text();
  const segmentUrl = playlist.split('\n').find(line => line.includes('/segments/1.mp3'));

  const response = await callHls(env, segmentUrl, runtime);
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 3)), 'ID3');
  assert.equal(parseMp3Duration(bytes).durationSeconds, 576 / 24000);
  assert.equal(readTimestamp(bytes), 2160n);

  const invalid = new URL(segmentUrl, 'https://app');
  invalid.searchParams.set('s', 'stale');
  const stale = await callHls(env, `${invalid.pathname}${invalid.search}`, runtime);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'HLS_SENTENCE_CHANGED');

  const tamperedTimestamp = new URL(segmentUrl, 'https://app');
  tamperedTimestamp.searchParams.set('t', '999');
  const tampered = await callHls(
    env,
    `${tamperedTimestamp.pathname}${tamperedTimestamp.search}`,
    runtime
  );
  assert.equal(tampered.status, 409);
  assert.equal((await tampered.json()).code, 'HLS_TIMESTAMP_CHANGED');
});

test('HLS segment serves prepared R2 audio only and never synthesizes during playback', async t => {
  const env = seededEnv();
  t.after(() => env.DB.close());
  let azureCalls = 0;
  const runtime = {
    fetch: async () => {
      azureCalls += 1;
      return new Response(mp3Frames(1));
    }
  };
  const prepared = await (
    await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime)
  ).json();
  const playlist = await (await callHls(env, prepared.playlistUrl, runtime)).text();
  const segmentUrl = playlist.split('\n').find(line => line.includes('/segments/0.mp3'));
  assert.equal(azureCalls, 2);

  env.AUDIO.deleteAudio();
  const missing = await callHls(env, segmentUrl, runtime);

  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'HLS_SEGMENT_NOT_PREPARED');
  assert.equal(azureCalls, 2);
});

test('HLS preparation returns a stable error for malformed synthesized MP3', async t => {
  const env = seededEnv();
  t.after(() => env.DB.close());
  const response = await callHls(
    env,
    '/api/tts/articles/a1/hls/prepare',
    { fetch: async () => new Response(new Uint8Array([1, 2, 3])) }
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'HLS_INVALID_AUDIO');
});

test('HLS preparation converges when duplicate sentences share an active generation lease', async t => {
  const env = seededEnv();
  t.after(() => env.DB.close());
  env.DB.exec("UPDATE articles SET body = 'Same sentence. Same sentence.' WHERE id = 'a1'");
  let releaseGeneration;
  let azureCalls = 0;
  const sleepDelays = [];
  const generationBarrier = new Promise(resolve => { releaseGeneration = resolve; });
  const runtime = {
    fetch: async () => {
      azureCalls += 1;
      await generationBarrier;
      return new Response(mp3Frames(1));
    },
    sleep: async delay => {
      sleepDelays.push(delay);
      if (sleepDelays.length === 5) releaseGeneration();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };

  const response = await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.sentences.length, 2);
  assert.equal(azureCalls, 1);
  assert.deepEqual(sleepDelays.slice(0, 5), [100, 200, 400, 800, 1000]);
});

test('HLS preparation batches long articles below the external subrequest limit', async t => {
  const env = seededEnv({ sentenceCount: 22 });
  t.after(() => env.DB.close());
  let azureCalls = 0;
  const runtime = {
    fetch: async () => {
      azureCalls += 1;
      return new Response(mp3Frames(1));
    }
  };

  const first = await callHls(env, '/api/tts/articles/a1/hls/prepare', runtime);
  const pending = await first.json();
  assert.equal(first.status, 202);
  assert.deepEqual(pending, { ready: false, nextCursor: 15 });
  assert.equal(azureCalls, 15);

  const final = await callHls(
    env,
    '/api/tts/articles/a1/hls/prepare?cursor=15',
    runtime
  );
  const prepared = await final.json();
  assert.equal(final.status, 200);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.sentences.length, 22);
  assert.equal(azureCalls, 22);
});

function callHls(env, path, runtime) {
  const url = new URL(path, 'https://app');
  if (!url.searchParams.has('profile')) url.searchParams.set('profile', 'aria-narration');
  return handleTtsHlsApi(new Request(url), env, url.pathname, 'u1', runtime);
}

function seededEnv({ sentenceCount = 2 } = {}) {
  const DB = createSqliteDb();
  const body = sentenceCount === 2
    ? 'First sentence. Second sentence.'
    : Array.from({ length: sentenceCount }, (_, index) => `Sentence ${index + 1}.`).join(' ');
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'one', 1);
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES
      ('a1', 'u1', 'One', '${body}', '', '', '', 1, 1);
  `);
  return {
    DB,
    AUDIO: memoryBucket(),
    AZURE_TTS_KEY: 'secret',
    AZURE_TTS_REGION: 'eastus',
    TTS_MONTHLY_CHAR_BUDGET: '450000'
  };
}

function memoryBucket() {
  const values = new Map();
  return {
    async get(key) {
      const value = values.get(key);
      return value ? { body: value, httpMetadata: { contentType: 'audio/mpeg' } } : null;
    },
    async put(key, value) {
      values.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
    },
    deleteAudio() {
      for (const key of values.keys()) {
        if (!key.startsWith('hls/')) values.delete(key);
      }
    }
  };
}

function mp3Frames(count) {
  const header = (
    0xffe00000 | (2 << 19) | (1 << 17) | (1 << 16) | (6 << 12) | (1 << 10)
  ) >>> 0;
  const result = new Uint8Array(144 * count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 144;
    result[offset] = header >>> 24;
    result[offset + 1] = header >>> 16;
    result[offset + 2] = header >>> 8;
    result[offset + 3] = header;
  }
  return result;
}

function readTimestamp(bytes) {
  const owner = new TextEncoder().encode('com.apple.streaming.transportStreamTimestamp');
  let start = -1;
  outer: for (let index = 0; index <= bytes.length - owner.length; index += 1) {
    for (let offset = 0; offset < owner.length; offset += 1) {
      if (bytes[index + offset] !== owner[offset]) continue outer;
    }
    start = index + owner.length + 1;
    break;
  }
  assert.ok(start > 0);
  let value = 0n;
  for (const byte of bytes.slice(start, start + 8)) value = (value << 8n) | BigInt(byte);
  return value;
}
