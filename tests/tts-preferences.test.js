import test from 'node:test';
import assert from 'node:assert/strict';

test('TTS preferences expose four profiles and distinct word/article defaults', async () => {
  const preferences = await loadModule();
  assert.ok(preferences, 'tts-preferences module must exist');
  assert.deepEqual(Object.keys(preferences.TTS_PROFILE_OPTIONS), [
    'jenny-chat', 'jenny-friendly', 'aria-narration', 'guy-news'
  ]);
  assert.deepEqual(preferences.DEFAULT_TTS_PREFERENCES, {
    wordProfile: 'jenny-chat', articleProfile: 'aria-narration'
  });
});

test('TTS preferences persist valid independent choices and reject corrupt storage', async () => {
  const preferences = await loadModule();
  assert.ok(preferences, 'tts-preferences module must exist');
  const storage = memoryStorage();
  assert.equal(preferences.saveTtsPreferences(storage, {
    wordProfile: 'jenny-friendly', articleProfile: 'guy-news'
  }), true);
  assert.deepEqual(preferences.loadTtsPreferences(storage), {
    wordProfile: 'jenny-friendly', articleProfile: 'guy-news'
  });

  storage.setItem(preferences.TTS_PREFERENCES_KEY, JSON.stringify({
    wordProfile: 'custom', articleProfile: 'guy-news'
  }));
  assert.deepEqual(
    preferences.loadTtsPreferences(storage),
    preferences.DEFAULT_TTS_PREFERENCES
  );
});

test('newer remote TTS preferences replace an older local value', { concurrency: false }, async t => {
  const preferences = await loadModule();
  const storage = memoryStorage();
  preferences.saveTtsPreferences(storage, {
    wordProfile: 'jenny-chat', articleProfile: 'aria-narration'
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (_path, init = {}) => {
    requests.push(init.method || 'GET');
    return jsonResponse({
      ttsPreferences: {
        wordProfile: 'jenny-friendly',
        articleProfile: 'guy-news'
      },
      updatedAt: Date.now() + 60_000
    });
  };

  assert.equal(await preferences.syncTtsPreferences(storage), true);
  assert.deepEqual(preferences.loadTtsPreferences(storage), {
    wordProfile: 'jenny-friendly', articleProfile: 'guy-news'
  });
  assert.deepEqual(requests, ['GET']);
});

test('newer local TTS preferences are uploaded to the server', { concurrency: false }, async t => {
  const preferences = await loadModule();
  const storage = memoryStorage();
  const local = {
    wordProfile: 'aria-narration',
    articleProfile: 'jenny-friendly'
  };
  preferences.saveTtsPreferences(storage, local);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (_path, init = {}) => {
    const method = init.method || 'GET';
    requests.push(method);
    if (method === 'PUT') {
      assert.deepEqual(JSON.parse(init.body), { ttsPreferences: local });
      return jsonResponse({ ttsPreferences: local, updatedAt: Date.now() });
    }
    return jsonResponse({
      ttsPreferences: {
        wordProfile: 'jenny-chat',
        articleProfile: 'aria-narration'
      },
      updatedAt: 1
    });
  };

  assert.equal(await preferences.syncTtsPreferences(storage), true);
  assert.deepEqual(preferences.loadTtsPreferences(storage), local);
  assert.deepEqual(requests, ['GET', 'PUT']);
});

async function loadModule() {
  return import('../public/lib/tts-preferences.js').catch(() => null);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
