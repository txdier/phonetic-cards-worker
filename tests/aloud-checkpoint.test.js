import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyFingerprint,
  createAloudCheckpointStore
} from '../public/lib/aloud-checkpoint.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

test('checkpoint restores only the same user article and body', () => {
  const storage = memoryStorage();
  const store = createAloudCheckpointStore({
    storage, username: 'alice', now: () => 99
  });
  store.save({
    articleId: 'a1', body: 'One. Two.', sentenceIndex: 1,
    offsetSeconds: 2.5, state: 'paused'
  });
  assert.deepEqual(store.load({ articleId: 'a1', body: 'One. Two.' }), {
    articleId: 'a1',
    bodyFingerprint: bodyFingerprint('One. Two.'),
    sentenceIndex: 1,
    offsetSeconds: 2.5,
    state: 'paused',
    savedAt: 99
  });
  assert.equal(store.load({ articleId: 'a1', body: 'Changed.' }), null);
});

test('checkpoint rejects invalid data and tolerates disabled storage', () => {
  const store = createAloudCheckpointStore({
    storage: {
      getItem() { throw new Error('disabled'); },
      setItem() { throw new Error('disabled'); },
      removeItem() { throw new Error('disabled'); }
    },
    username: 'alice'
  });
  assert.equal(store.save({
    articleId: 'a1', body: 'Body.', sentenceIndex: -1,
    offsetSeconds: 0, state: 'paused'
  }), false);
  assert.equal(store.load({ articleId: 'a1', body: 'Body.' }), null);
  assert.equal(store.clear('a1'), false);
});

test('checkpoint rejects a persisted state outside the supported states', () => {
  const storage = memoryStorage();
  storage.setItem('pc-aloud-checkpoint:alice:a1', JSON.stringify({
    articleId: 'a1',
    bodyFingerprint: bodyFingerprint('Body.'),
    sentenceIndex: 0,
    offsetSeconds: 1,
    state: 'finished',
    savedAt: 99
  }));
  const store = createAloudCheckpointStore({ storage, username: 'alice' });

  assert.equal(store.load({ articleId: 'a1', body: 'Body.' }), null);
});

test('checkpoint reports unavailable storage as an unsuccessful save or clear', () => {
  const store = createAloudCheckpointStore({ username: 'alice' });

  assert.equal(store.save({
    articleId: 'a1', body: 'Body.', sentenceIndex: 0,
    offsetSeconds: 0, state: 'speaking'
  }), false);
  assert.equal(store.clear('a1'), false);
});
