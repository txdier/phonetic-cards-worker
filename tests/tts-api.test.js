import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTtsApi } from '../src/tts-api.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('TTS caches audio and reuses an identical sentence across articles', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  const AUDIO = memoryBucket();
  let azureCalls = 0;
  const runtime = {
    now: () => new Date('2026-07-27T00:00:00.000Z'),
    fetch: async () => {
      azureCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
  };
  const env = configuredEnv(DB, AUDIO);

  const first = await handleTtsApi(
    new Request('https://app/api/tts/articles/a1/sentences/0'),
    env, '/api/tts/articles/a1/sentences/0', 'u1', runtime
  );
  const second = await handleTtsApi(
    new Request('https://app/api/tts/articles/a2/sentences/0'),
    env, '/api/tts/articles/a2/sentences/0', 'u1', runtime
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(azureCalls, 1);
  assert.equal(second.headers.get('x-tts-cache'), 'hit');
});

test('TTS omits a standalone speaker label without requiring dialogue classification', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  DB.exec(`
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES
      ('a3', 'u1', 'Single speaker', 'Alice: Hello there. Plain narration.', '', '', '', 1, 1);
  `);
  const bodies = [];
  const response = await handleTtsApi(
    new Request('https://app/api/tts/articles/a3/sentences/0'),
    configuredEnv(DB, memoryBucket()),
    '/api/tts/articles/a3/sentences/0',
    'u1',
    {
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return new Response(new Uint8Array([1]));
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], />Hello there\.<\/mstts:express-as>/);
  assert.doesNotMatch(bodies[0], /Alice:/);
});

test('TTS refuses generation over the monthly character budget', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  let azureCalls = 0;
  const response = await handleTtsApi(
    new Request('https://app/api/tts/words/w1?mode=word'),
    { ...configuredEnv(DB, memoryBucket()), TTS_MONTHLY_CHAR_BUDGET: '2' },
    '/api/tts/words/w1', 'u1',
    { fetch: async () => { azureCalls += 1; return new Response('audio'); } }
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'TTS_BUDGET_EXCEEDED');
  assert.equal(azureCalls, 0);
});

test('TTS falls back after Azure keeps returning 429', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  let azureCalls = 0;
  const response = await handleTtsApi(
    new Request('https://app/api/tts/words/w1?mode=word'),
    configuredEnv(DB, memoryBucket()),
    '/api/tts/words/w1', 'u1',
    {
      fetch: async () => {
        azureCalls += 1;
        return new Response('', { status: 429 });
      }
    }
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).fallback, 'web-speech');
  assert.equal(azureCalls, 3);
  assert.equal(DB.get(
    'SELECT reserved_chars FROM tts_monthly_usage WHERE user_id = ?', 'u1'
  ).reserved_chars, 0);
});

test('TTS charges successful Azure synthesis even when R2 storage fails', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  const AUDIO = {
    async get() { return null; },
    async put() { throw new Error('R2 unavailable'); }
  };
  const response = await handleTtsApi(
    new Request('https://app/api/tts/words/w1?mode=word'),
    configuredEnv(DB, AUDIO),
    '/api/tts/words/w1', 'u1',
    { fetch: async () => new Response(new Uint8Array([1]), { status: 200 }) }
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'TTS_CACHE_WRITE_FAILED');
  assert.equal(DB.get(
    'SELECT used_chars FROM tts_monthly_usage WHERE user_id = ?', 'u1'
  ).used_chars, 'confirm'.length);
});

test('TTS applies allowlisted Azure voice styles and isolates profile caches', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  const AUDIO = memoryBucket();
  const bodies = [];
  const runtime = {
    fetch: async (_url, init) => {
      bodies.push(init.body);
      return new Response(new Uint8Array([1]), { status: 200 });
    }
  };
  const env = configuredEnv(DB, AUDIO);

  const chat = await handleTtsApi(
    new Request('https://app/api/tts/words/w1?mode=word&profile=jenny-chat'),
    env, '/api/tts/words/w1', 'u1', runtime
  );
  const narration = await handleTtsApi(
    new Request('https://app/api/tts/words/w1?mode=word&profile=aria-narration'),
    env, '/api/tts/words/w1', 'u1', runtime
  );

  assert.equal(chat.status, 200);
  assert.equal(narration.status, 200);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /name="en-US-JennyNeural"/);
  assert.match(bodies[0], /mstts:express-as style="chat"/);
  assert.match(bodies[1], /name="en-US-AriaNeural"/);
  assert.match(bodies[1], /mstts:express-as style="narration-professional"/);
  assert.match(bodies[1], /xmlns:mstts="https:\/\/www\.w3\.org\/2001\/mstts"/);
});

test('TTS rejects a profile outside the server allowlist before generation', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  let calls = 0;
  const response = await handleTtsApi(
    new Request('https://app/api/tts/words/w1?mode=word&profile=custom-voice'),
    configuredEnv(DB, memoryBucket()), '/api/tts/words/w1', 'u1',
    { fetch: async () => { calls += 1; return new Response('audio'); } }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_TTS_PROFILE');
  assert.equal(calls, 0);
});

function seededDb() {
  const DB = createSqliteDb();
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'one', 1);
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES ('w1', 'u1', 'confirm', 'confirm', '确认', 'Please confirm.', '', 0, 1);
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES
      ('a1', 'u1', 'One', 'The same sentence. Another one.', '', '', '', 1, 1),
      ('a2', 'u1', 'Two', 'The same sentence. Different ending.', '', '', '', 1, 1);
  `);
  return DB;
}

function configuredEnv(DB, AUDIO) {
  return {
    DB, AUDIO,
    AZURE_TTS_KEY: 'secret',
    AZURE_TTS_REGION: 'eastus',
    AZURE_TTS_VOICE: 'en-US-JennyNeural',
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
    }
  };
}
