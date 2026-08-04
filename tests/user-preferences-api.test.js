import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUserPreferencesApi } from '../src/user-preferences-api.js';

const PATH = '/api/user-preferences';
const USER_ID = 'user-1';

test('user preference API stores and returns valid TTS profiles', async () => {
  const DB = fakeDb();
  const preferences = {
    wordProfile: 'jenny-friendly',
    articleProfile: 'guy-news'
  };

  const saved = await handleUserPreferencesApi(
    new Request(`https://example.test${PATH}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttsPreferences: preferences })
    }),
    { DB },
    PATH,
    USER_ID
  );
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.deepEqual(savedBody.ttsPreferences, preferences);
  assert.ok(savedBody.updatedAt > 0);

  const loaded = await handleUserPreferencesApi(
    new Request(`https://example.test${PATH}`),
    { DB },
    PATH,
    USER_ID
  );
  assert.equal(loaded.status, 200);
  const loadedBody = await loaded.json();
  assert.deepEqual(loadedBody.ttsPreferences, preferences);
  assert.equal(loadedBody.updatedAt, savedBody.updatedAt);
});

test('user preference API rejects unknown or incomplete profiles', async () => {
  const DB = fakeDb();
  const response = await handleUserPreferencesApi(
    new Request(`https://example.test${PATH}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ttsPreferences: {
          wordProfile: 'custom-voice',
          articleProfile: 'guy-news'
        }
      })
    }),
    { DB },
    PATH,
    USER_ID
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_TTS_PREFERENCES');
});

test('user preference API ignores corrupt stored JSON', async () => {
  const DB = fakeDb({
    tts_preferences_json: '{broken',
    updated_at: 123
  });
  const response = await handleUserPreferencesApi(
    new Request(`https://example.test${PATH}`),
    { DB },
    PATH,
    USER_ID
  );
  assert.deepEqual(await response.json(), {
    ttsPreferences: {},
    updatedAt: 123
  });
});

function fakeDb(initialRow = null) {
  let row = initialRow;
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              return row;
            },
            async run() {
              if (/INSERT INTO user_preferences/.test(sql)) {
                row = {
                  tts_preferences_json: values[1],
                  updated_at: values[2]
                };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
}
