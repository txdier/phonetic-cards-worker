import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadTranslationMode,
  saveTranslationMode
} from '../public/lib/translation-preferences.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

test('translation mode persists only supported values', () => {
  const storage = memoryStorage();
  assert.equal(loadTranslationMode(storage), 'original');
  assert.equal(saveTranslationMode(storage, 'sentence'), true);
  assert.equal(loadTranslationMode(storage), 'sentence');
  assert.equal(saveTranslationMode(storage, 'invalid'), false);
  assert.equal(loadTranslationMode(storage), 'sentence');
});

test('translation mode tolerates corrupt and unavailable storage', () => {
  assert.equal(loadTranslationMode({ getItem() { return 'broken'; } }), 'original');
  assert.equal(loadTranslationMode({ getItem() { throw new Error('disabled'); } }), 'original');
  assert.equal(saveTranslationMode({ setItem() { throw new Error('disabled'); } }, 'full'), false);
});
