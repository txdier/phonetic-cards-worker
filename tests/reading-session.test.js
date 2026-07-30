import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProgressQueue,
  createReadingSession,
  progressQueueKey,
  sendProgressItem
} from '../public/lib/reading-session.js';

test('active time stops after sixty seconds idle and while hidden', () => {
  let time = 0;
  const session = createReadingSession({ now: () => time, idleMs: 60_000 });
  session.setVisible(true);
  session.interact();
  time = 30_000;
  assert.equal(session.flushActiveMs(), 30_000);
  time = 100_000;
  assert.equal(session.flushActiveMs(), 30_000);
  session.interact();
  time = 110_000;
  session.setVisible(false);
  time = 150_000;
  assert.equal(session.flushActiveMs(), 10_000);
});

test('completion requires top before bottom and returning to top rearms it', () => {
  const session = createReadingSession({ now: () => 0 });
  assert.equal(session.updatePosition(1).readCompleted, false);
  session.updatePosition(0.01);
  assert.equal(session.updatePosition(0.99).readCompleted, true);
  assert.equal(session.updatePosition(1).readCompleted, false);
  session.updatePosition(0);
  assert.equal(session.updatePosition(1).readCompleted, true);
});

test('position is clamped and read-aloud completion is exposed once per signal', () => {
  const session = createReadingSession({ now: () => 0 });
  assert.equal(session.updatePosition(4).positionRatio, 1);
  assert.equal(session.updatePosition(-2).positionRatio, 0);
  assert.equal(session.markReadAloudComplete().readAloudCompleted, true);
  assert.deepEqual(session.snapshot(), {
    visible: false,
    positionRatio: 0,
    topArmed: true
  });
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    read: key => values.get(key) ?? null
  };
}

test('progress queue persists failed work and retries FIFO, deleting only acknowledgements', async () => {
  const storage = memoryStorage();
  const attempts = [];
  let fail = true;
  const queue = createProgressQueue({
    storage,
    send: async item => {
      attempts.push(item.id);
      if (fail) throw new Error('offline');
    }
  });

  assert.equal(await queue.submit({ id: 'first' }), false);
  assert.deepEqual(JSON.parse(storage.read('pc-progress-queue')), [{ id: 'first' }]);
  await queue.submit({ id: 'second' });
  assert.deepEqual(attempts, ['first', 'first']);
  assert.deepEqual(queue.snapshot(), [{ id: 'first' }, { id: 'second' }]);

  fail = false;
  assert.equal(await queue.retry(), true);
  assert.deepEqual(attempts, ['first', 'first', 'first', 'second']);
  assert.deepEqual(queue.snapshot(), []);
  assert.equal(storage.read('pc-progress-queue'), null);
});

test('progress queue loads stored work and serializes simultaneous retries', async () => {
  const storage = memoryStorage({ 'pc-progress-queue': JSON.stringify([{ id: 'stored' }]) });
  let resolve;
  const pending = new Promise(onResolve => { resolve = onResolve; });
  let calls = 0;
  const queue = createProgressQueue({ storage, send: async () => { calls += 1; await pending; } });
  const one = queue.retry();
  const two = queue.retry();
  assert.equal(calls, 1);
  resolve();
  assert.equal(await one, true);
  assert.equal(await two, true);
  assert.equal(calls, 1);
});

test('progress queue compacts positions to the latest atomic scroll and aloud snapshot per article', async () => {
  const stored = [
    { kind: 'event', articleId: 'a1', event: { id: 'e1', type: 'active_ms', amount: 10 } },
    {
      kind: 'position', articleId: 'a1', lastPositionRatio: 0.1,
      lastAloudSentenceIndex: null, lastAloudOffsetSeconds: 0
    },
    { kind: 'event', articleId: 'a1', event: { id: 'e2', type: 'read_complete', amount: 1 } },
    {
      kind: 'position', articleId: 'a2', lastPositionRatio: 0.4,
      lastAloudSentenceIndex: 2, lastAloudOffsetSeconds: 1.2
    },
    {
      kind: 'position', articleId: 'a1', lastPositionRatio: 0.9,
      lastAloudSentenceIndex: 5, lastAloudOffsetSeconds: -6.7
    }
  ];
  const storage = memoryStorage({ 'pc-progress-queue': JSON.stringify(stored) });
  const sent = [];
  const queue = createProgressQueue({
    storage,
    send: async item => { sent.push(item); }
  });

  const expected = [stored[0], stored[2], stored[3], {
    ...stored[4], lastAloudOffsetSeconds: 0
  }];
  assert.deepEqual(queue.snapshot(), expected);
  assert.equal(await queue.retry(), true);
  assert.deepEqual(sent, expected);
  assert.equal(storage.read('pc-progress-queue'), null);
});

test('progress sender maps queued events and positions to the API contract', async () => {
  const calls = [];
  const api = async (path, init) => { calls.push({ path, init }); return { ok: true }; };
  await sendProgressItem(api, {
    kind: 'event', articleId: 'a/1',
    event: { id: 'e1', type: 'active_ms', amount: 50 }
  });
  await sendProgressItem(api, { kind: 'position', articleId: 'a/1', lastPositionRatio: 0.4 });
  await sendProgressItem(api, {
    kind: 'position', articleId: 'a/1', lastPositionRatio: 0.5,
    lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 2.5
  });
  assert.deepEqual(calls, [{
    path: '/api/articles/a%2F1/progress/events',
    init: { method: 'POST', body: JSON.stringify({ id: 'e1', type: 'active_ms', amount: 50 }) }
  }, {
    path: '/api/articles/a%2F1/progress',
    init: { method: 'PATCH', body: JSON.stringify({ lastPositionRatio: 0.4 }) }
  }, {
    path: '/api/articles/a%2F1/progress',
    init: {
      method: 'PATCH',
      body: JSON.stringify({
        lastPositionRatio: 0.5,
        lastAloudSentenceIndex: 3,
        lastAloudOffsetSeconds: 2.5
      })
    }
  }]);
});

test('progress sender normalizes invalid aloud offsets to a finite zero', async () => {
  const calls = [];
  const api = async (path, init) => { calls.push({ path, init }); return { ok: true }; };

  for (const offset of [Infinity, NaN, -2]) {
    await sendProgressItem(api, {
      kind: 'position', articleId: 'a1', lastPositionRatio: 0.5,
      lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: offset
    });
  }

  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body)), [
    { lastPositionRatio: 0.5, lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 0 },
    { lastPositionRatio: 0.5, lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 0 },
    { lastPositionRatio: 0.5, lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 0 }
  ]);
});

test('queue retries an invalid aloud offset as a finite atomic snapshot', async () => {
  const storage = memoryStorage();
  const sent = [];
  let offline = true;
  const queue = createProgressQueue({
    storage,
    send: item => sendProgressItem(async (path, init) => {
      const body = JSON.parse(init.body);
      sent.push({ path, body });
      if (offline) throw new Error('offline');
      if (!Number.isFinite(body.lastAloudOffsetSeconds)) throw new Error('invalid offset');
      return { ok: true };
    }, item)
  });

  assert.equal(await queue.submit({
    kind: 'position', articleId: 'a1', lastPositionRatio: 0.5,
    lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: Infinity
  }), false);
  assert.deepEqual(queue.snapshot(), [{
    kind: 'position', articleId: 'a1', lastPositionRatio: 0.5,
    lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 0
  }]);

  offline = false;
  assert.equal(await queue.retry(), true);
  assert.deepEqual(sent, [{
    path: '/api/articles/a1/progress',
    body: { lastPositionRatio: 0.5, lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 0 }
  }, {
    path: '/api/articles/a1/progress',
    body: { lastPositionRatio: 0.5, lastAloudSentenceIndex: 3, lastAloudOffsetSeconds: 0 }
  }]);
});

test('authenticated users use isolated queue keys so one account cannot block another', async () => {
  const storage = memoryStorage();
  const a = createProgressQueue({
    storage, key: progressQueueKey('alice@example.com'),
    send: async () => { throw new Error('alice offline'); }
  });
  const sentByB = [];
  const b = createProgressQueue({
    storage, key: progressQueueKey('bob'),
    send: async item => { sentByB.push(item.id); }
  });
  await a.submit({ id: 'alice-event' });
  assert.equal(await b.submit({ id: 'bob-event' }), true);
  assert.deepEqual(sentByB, ['bob-event']);
  assert.deepEqual(JSON.parse(storage.read('pc-progress-queue:alice%40example.com')), [{ id: 'alice-event' }]);
  assert.equal(storage.read('pc-progress-queue:bob'), null);
});
