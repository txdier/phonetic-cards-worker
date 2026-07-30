import test from 'node:test';
import assert from 'node:assert/strict';
import { createSleepTimer } from '../public/lib/sleep-timer.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

test('sleep timer uses an absolute deadline and expires once', () => {
  let now = 1_000;
  const storage = memoryStorage();
  const timer = createSleepTimer({
    storage, key: 'timer:alice:a1', now: () => now,
    setInterval: () => 1, clearInterval() {}
  });
  const events = [];
  timer.subscribe(state => events.push(state));
  assert.equal(timer.setMinutes(10), true);
  now = 601_000;
  assert.equal(timer.check().expired, true);
  assert.equal(timer.check().expired, false);
  assert.deepEqual(timer.snapshot(), {
    active: false, deadline: null, remainingMs: 0, expired: false
  });
  assert.equal(storage.getItem('timer:alice:a1'), null);
  assert.equal(events.at(-1).expired, true);
});

test('sleep timer restores a future deadline and rejects invalid minutes', () => {
  let now = 5_000;
  const storage = memoryStorage({
    'timer:alice:a1': JSON.stringify({ deadline: 65_000 })
  });
  const timer = createSleepTimer({
    storage, key: 'timer:alice:a1', now: () => now,
    setInterval: () => 1, clearInterval() {}
  });
  assert.equal(timer.snapshot().remainingMs, 60_000);
  assert.equal(timer.setMinutes(0), false);
  assert.equal(timer.setMinutes(1.5), false);
});

test('sleep timer clears expired storage before notifying subscribers', () => {
  let now = 1_000;
  const storage = memoryStorage();
  const timer = createSleepTimer({
    storage, key: 'timer:alice:a1', now: () => now,
    setInterval: () => 1, clearInterval() {}
  });
  timer.setMinutes(1);
  now = 61_000;
  let storageWhenNotified = 'not notified';
  timer.subscribe(() => { storageWhenNotified = storage.getItem('timer:alice:a1'); });

  timer.check();

  assert.equal(storageWhenNotified, null);
});

test('sleep timer maintains one ticker and cleanup preserves a future deadline', () => {
  let now = 1_000;
  const storage = memoryStorage();
  const intervals = [];
  const cleared = [];
  const timer = createSleepTimer({
    storage, key: 'timer:alice:a1', now: () => now, tickMs: 250,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    clearInterval: id => cleared.push(id)
  });

  assert.equal(timer.setMinutes(1), true);
  assert.equal(timer.setMinutes(2), true);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 250);
  timer.cleanup();

  assert.deepEqual(cleared, [1]);
  assert.deepEqual(JSON.parse(storage.getItem('timer:alice:a1')), { deadline: 121_000 });
});

test('sleep timer tolerates unavailable storage and cancel publishes inactive state', () => {
  const events = [];
  const timer = createSleepTimer({
    storage: {
      getItem() { throw new Error('disabled'); },
      setItem() { throw new Error('disabled'); },
      removeItem() { throw new Error('disabled'); }
    },
    key: 'timer:alice:a1', now: () => 1_000,
    setInterval: () => 1, clearInterval() {}
  });
  timer.subscribe(state => events.push(state));

  assert.equal(timer.setMinutes(1), true);
  timer.cancel();

  assert.deepEqual(events.at(-1), {
    active: false, deadline: null, remainingMs: 0, expired: false
  });
});
