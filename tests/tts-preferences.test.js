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
