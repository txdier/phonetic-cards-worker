import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_READER_PREFERENCES,
  READER_PREFERENCES_KEY,
  loadReaderPreferences,
  readerPreferenceStyles,
  saveReaderPreferences
} from '../public/lib/reader-preferences.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: key => values.get(key) ?? null
  };
}

test('reader preferences load valid global choices and expose exact typography values', () => {
  const storage = memoryStorage({
    [READER_PREFERENCES_KEY]: JSON.stringify({
      fontSize: 'large', lineHeight: 'loose', measure: 'wide'
    })
  });
  const preferences = loadReaderPreferences(storage);

  assert.deepEqual(preferences, { fontSize: 'large', lineHeight: 'loose', measure: 'wide' });
  assert.deepEqual(readerPreferenceStyles(preferences), {
    fontSize: '21px', lineHeight: '2.1', maxWidth: '880px'
  });
  assert.deepEqual(readerPreferenceStyles({
    fontSize: 'small', lineHeight: 'compact', measure: 'narrow'
  }), { fontSize: '17px', lineHeight: '1.7', maxWidth: '640px' });
});

test('reader preferences fall back when storage is corrupt, invalid, or unavailable', () => {
  assert.deepEqual(loadReaderPreferences(memoryStorage({
    [READER_PREFERENCES_KEY]: '{bad json'
  })), DEFAULT_READER_PREFERENCES);
  assert.deepEqual(loadReaderPreferences(memoryStorage({
    [READER_PREFERENCES_KEY]: JSON.stringify({
      fontSize: 'huge', lineHeight: 'comfortable', measure: 'medium'
    })
  })), DEFAULT_READER_PREFERENCES);
  assert.deepEqual(loadReaderPreferences({ getItem() { throw new Error('disabled'); } }), DEFAULT_READER_PREFERENCES);
  assert.deepEqual(readerPreferenceStyles(DEFAULT_READER_PREFERENCES), {
    fontSize: '19px', lineHeight: '1.9', maxWidth: '760px'
  });
});

test('reader preferences save only valid choices and tolerate disabled storage', () => {
  const storage = memoryStorage();
  assert.equal(saveReaderPreferences(storage, {
    fontSize: 'small', lineHeight: 'loose', measure: 'wide'
  }), true);
  assert.deepEqual(JSON.parse(storage.value(READER_PREFERENCES_KEY)), {
    fontSize: 'small', lineHeight: 'loose', measure: 'wide'
  });
  assert.equal(saveReaderPreferences(storage, {
    fontSize: 'invalid', lineHeight: 'loose', measure: 'wide'
  }), false);
  assert.equal(saveReaderPreferences({ setItem() { throw new Error('disabled'); } }, DEFAULT_READER_PREFERENCES), false);
});
