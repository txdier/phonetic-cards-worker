import test from 'node:test';
import assert from 'node:assert/strict';

import { createArticleTranslationScheduler } from '../public/lib/article-translation-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function translationState(completed = [], completedBatch = null) {
  const completedIndexes = new Set(completed);
  const batches = [0, 1, 2, 3].map(index => ({
    index,
    paragraphIndexes: [index],
    completed: completedIndexes.has(index)
  }));
  return {
    status: completed.length === batches.length
      ? 'fresh'
      : completed.length ? 'partial' : 'missing',
    sourceHash: 'a'.repeat(64),
    rulesVersion: 'article-v2-progressive',
    titleZh: completedIndexes.has(0) ? 'Translated title' : '',
    paragraphs: completed.map(index => ({ index, translation: `translation ${index}` })),
    batches,
    completedBatches: completed.length,
    totalBatches: batches.length,
    ...(completedBatch == null ? {} : { completedBatch })
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

test('article translation scheduler prioritizes batch zero then runs at most two later batches', async () => {
  const requests = new Map([0, 1, 2, 3].map(index => [index, deferred()]));
  const started = [];
  const renderedBatches = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const scheduler = createArticleTranslationScheduler({
    async requestBatch(batch) {
      started.push(batch.index);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await requests.get(batch.index).promise;
      } finally {
        concurrent -= 1;
      }
    },
    onBatch(result) {
      renderedBatches.push(result.completedBatch);
    },
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  scheduler.start(translationState());
  const startedBeforeFirstResolution = [...started];
  assert.deepEqual(startedBeforeFirstResolution, [0]);

  requests.get(0).resolve(translationState([0], 0));
  await flush();
  assert.deepEqual(started, [0, 1, 2]);

  requests.get(2).resolve(translationState([0, 2], 2));
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);

  requests.get(1).resolve(translationState([0, 1, 2], 1));
  await flush();
  requests.get(3).resolve(translationState([0, 1, 2, 3], 3));
  await flush();

  assert.equal(maxConcurrent, 2);
  assert.deepEqual(renderedBatches, [0, 2, 1, 3]);
});

test('article translation scheduler skips queued batches completed by the first response', async () => {
  const first = deferred();
  const started = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      started.push(batch.index);
      return batch.index === 0
        ? first.promise
        : Promise.resolve(translationState([0, 1, 2, 3], batch.index));
    },
    onBatch() {},
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  scheduler.start(translationState());
  first.resolve(translationState([0, 1, 2, 3], 0));
  await flush();

  assert.deepEqual(started, [0]);
});

test('article translation scheduler requests duplicate batch indexes only once', async () => {
  const first = deferred();
  const later = new Map([[1, deferred()], [2, deferred()]]);
  const started = [];
  const activeByIndex = new Map();
  let duplicateConcurrent = false;
  const duplicateState = {
    ...translationState(),
    batches: [
      { index: 0, paragraphIndexes: [0], completed: false },
      { index: 0, paragraphIndexes: [0], completed: false },
      { index: 1, paragraphIndexes: [1], completed: false },
      { index: 1, paragraphIndexes: [1], completed: false },
      { index: 2, paragraphIndexes: [2], completed: false }
    ]
  };
  const scheduler = createArticleTranslationScheduler({
    async requestBatch(batch) {
      started.push(batch.index);
      const active = (activeByIndex.get(batch.index) || 0) + 1;
      activeByIndex.set(batch.index, active);
      duplicateConcurrent ||= active > 1;
      try {
        return await (batch.index === 0 ? first.promise : later.get(batch.index).promise);
      } finally {
        activeByIndex.set(batch.index, activeByIndex.get(batch.index) - 1);
      }
    },
    onBatch() {},
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  scheduler.start(duplicateState);
  first.resolve(translationState([0], 0));
  await flush();
  later.get(1).resolve(translationState([0, 1], 1));
  later.get(2).resolve(translationState([0, 1, 2], 2));
  await flush();

  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(duplicateConcurrent, false);
});

test('article translation scheduler suspends new work and resumes only missing batches', async () => {
  const requests = new Map([0, 1, 2, 3].map(index => [index, deferred()]));
  const started = [];
  const renderedBatches = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      started.push(batch.index);
      return requests.get(batch.index).promise;
    },
    onBatch(result) {
      renderedBatches.push(result.completedBatch);
    },
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  scheduler.start(translationState());
  requests.get(0).resolve(translationState([0], 0));
  await flush();
  assert.deepEqual(started, [0, 1, 2]);

  scheduler.suspend();
  requests.get(2).resolve(translationState([0, 2], 2));
  await flush();
  assert.deepEqual(renderedBatches, [0, 2]);
  assert.deepEqual(started, [0, 1, 2]);

  requests.get(1).resolve(translationState([0, 1, 2], 1));
  await flush();
  assert.deepEqual(renderedBatches, [0, 2, 1]);
  assert.deepEqual(started, [0, 1, 2]);

  scheduler.start(translationState([0, 1, 2]));
  assert.deepEqual(started, [0, 1, 2, 3]);
  requests.get(3).resolve(translationState([0, 1, 2, 3], 3));
  await flush();
  assert.deepEqual(renderedBatches, [0, 2, 1, 3]);
});

test('article translation scheduler keeps first-batch priority across suspend and resume', async () => {
  const requests = new Map([0, 1, 2, 3].map(index => [index, deferred()]));
  const started = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      started.push(batch.index);
      return requests.get(batch.index).promise;
    },
    onBatch() {},
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  const missing = translationState();
  scheduler.start(missing);
  scheduler.suspend();
  scheduler.start(missing);
  assert.deepEqual(started, [0]);

  requests.get(0).resolve(translationState([0], 0));
  await flush();
  assert.deepEqual(started, [0, 1, 2]);

  scheduler.invalidate();
  requests.get(1).resolve(translationState([0, 1], 1));
  requests.get(2).resolve(translationState([0, 2], 2));
});

test('article translation scheduler does not start later work after a synchronous first-batch failure', () => {
  const started = [];
  const errors = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      started.push(batch.index);
      if (batch.index === 0) throw new Error('synchronous failure');
      return Promise.resolve(translationState([batch.index], batch.index));
    },
    onBatch() {},
    onError(error) {
      errors.push(error.message);
    }
  });

  scheduler.start(translationState());

  assert.deepEqual(started, [0]);
  assert.deepEqual(errors, ['synchronous failure']);
});

test('article translation scheduler invalidation makes stale callbacks inert', async () => {
  const first = deferred();
  const started = [];
  const renderedBatches = [];
  const errors = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      started.push(batch.index);
      return first.promise;
    },
    onBatch(result) {
      renderedBatches.push(result.completedBatch);
    },
    onError(error) {
      errors.push(error);
    }
  });

  scheduler.start(translationState());
  scheduler.invalidate();
  first.resolve(translationState([0], 0));
  await flush();

  assert.deepEqual(started, [0]);
  assert.deepEqual(renderedBatches, []);
  assert.deepEqual(errors, []);
});

test('translation scheduler retries only transient failures once and exposes the second failure', async () => {
  const retryableCodes = [
    'TRANSLATION_TIMEOUT',
    'TRANSLATION_UNAVAILABLE',
    'TRANSLATION_FORMAT_INVALID'
  ];

  for (const code of retryableCodes) {
    let attempts = 0;
    const errors = [];
    const scheduler = createArticleTranslationScheduler({
      requestBatch() {
        attempts += 1;
        const error = new Error(`${code} attempt ${attempts}`);
        error.code = code;
        return Promise.reject(error);
      },
      onBatch() {},
      onError(error, details) {
        errors.push({ error, details });
      }
    });

    scheduler.start(translationState());
    await flush();

    assert.equal(attempts, 2, code);
    assert.equal(errors.length, 1, code);
    assert.equal(errors[0].error.message, `${code} attempt 2`);
    assert.notEqual(errors[0].details?.terminal, true);
  }

  let attempts = 0;
  const errors = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch() {
      attempts += 1;
      const error = new Error('source changed');
      error.code = 'TRANSLATION_SOURCE_CHANGED';
      return Promise.reject(error);
    },
    onBatch() {},
    onError(error) {
      errors.push(error);
    }
  });

  scheduler.start(translationState());
  await flush();

  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
});

test('translation quota stops every queued batch and reports a terminal error', async () => {
  const first = deferred();
  const later = new Map([[1, deferred()], [2, deferred()]]);
  const started = [];
  const errors = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      started.push(batch.index);
      return batch.index === 0 ? first.promise : later.get(batch.index).promise;
    },
    onBatch() {},
    onError(error, details) {
      errors.push({ error, details });
    }
  });

  scheduler.start(translationState());
  first.resolve(translationState([0], 0));
  await flush();
  assert.deepEqual(started, [0, 1, 2]);

  const quotaError = new Error('daily translation limit reached');
  quotaError.code = 'TRANSLATION_DAILY_LIMIT';
  later.get(1).reject(quotaError);
  await flush();
  later.get(2).resolve(translationState([0, 2], 2));
  await flush();

  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, quotaError);
  assert.deepEqual(errors[0].details, { terminal: true });
});

test('refreshes progressive batches in a new generation and ignores the superseded request', async () => {
  const calls = [];
  const rendered = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch, state, refresh) {
      const gate = deferred();
      calls.push({ index: batch.index, refresh, gate });
      return gate.promise;
    },
    onBatch(result) {
      rendered.push(result.marker);
    },
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  scheduler.start(translationState());
  assert.deepEqual(calls.map(call => [call.index, call.refresh]), [[0, false]]);

  scheduler.start(translationState([0, 1, 2, 3]), { refresh: true });
  assert.deepEqual(calls.map(call => [call.index, call.refresh]), [[0, false]]);

  calls[0].gate.resolve({ ...translationState([0], 0), marker: 'superseded' });
  await flush();
  assert.deepEqual(calls.map(call => [call.index, call.refresh]), [
    [0, false],
    [0, true]
  ]);
  calls[1].gate.resolve({ ...translationState([0], 0), marker: 'new-0' });
  await flush();
  assert.deepEqual(calls.map(call => call.index), [0, 0, 1, 2]);

  calls[2].gate.resolve({ ...translationState([0, 1], 1), marker: 'new-1' });
  calls[3].gate.resolve({ ...translationState([0, 2], 2), marker: 'new-2' });
  await flush();
  assert.deepEqual(calls.map(call => call.index), [0, 0, 1, 2, 3]);
  calls[4].gate.resolve({ ...translationState([0, 1, 2, 3], 3), marker: 'new-3' });
  await flush();

  assert.ok(calls.slice(1).every(call => call.refresh === true));
  assert.deepEqual(rendered, ['new-0', 'new-1', 'new-2', 'new-3']);
});

test('superseded refreshes never exceed two physical requests', async () => {
  const calls = [];
  let physical = 0;
  let maxPhysical = 0;
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch, state, refresh) {
      const gate = deferred();
      physical += 1;
      maxPhysical = Math.max(maxPhysical, physical);
      calls.push({ batch: batch.index, refresh, gate });
      return gate.promise.finally(() => { physical -= 1; });
    },
    onBatch() {},
    onError(error) { assert.fail(error.message); }
  });
  scheduler.start(translationState([0]));
  assert.equal(calls.length, 2);
  scheduler.start(translationState([0, 1, 2, 3]), { refresh: true });
  assert.equal(calls.length, 2);
  calls[0].gate.resolve(translationState([0, 1], 1));
  await flush();
  assert.equal(calls.length, 2);
  calls[1].gate.resolve(translationState([0, 2], 2));
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].batch, 0);
  assert.equal(maxPhysical, 2);
  scheduler.invalidate();
  calls[2].gate.resolve(translationState([0], 0));
});

test('queued refresh bases its CAS on the run that actually settled before it starts', async () => {
  const calls = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch, state, refresh) {
      const gate = deferred();
      calls.push({ batch: batch.index, state: { ...state }, refresh, gate });
      return gate.promise;
    },
    onBatch() {},
    onError(error) { assert.fail(error.message); }
  });
  const cached = { ...translationState([0, 1, 2, 3]), runToken: 'run-base' };
  scheduler.start(cached, { refresh: true });
  const firstRunToken = calls[0].state.runToken;
  scheduler.start(cached, { refresh: true });
  assert.equal(calls.length, 1);
  calls[0].gate.resolve({
    ...translationState([0], 0), runToken: firstRunToken
  });
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].state.previousRunToken, firstRunToken);
  assert.notEqual(calls[1].state.runToken, firstRunToken);
  scheduler.invalidate();
  calls[1].gate.resolve({ ...translationState([0], 0), runToken: calls[1].state.runToken });
});

test('article translation invalidation clears pending forced-refresh work', () => {
  const request = deferred();
  const scheduler = createArticleTranslationScheduler({
    requestBatch() {
      return request.promise;
    },
    onBatch() {},
    onError(error) {
      assert.fail(`unexpected scheduler error: ${error.message}`);
    }
  });

  scheduler.start(translationState([0, 1, 2, 3]), { refresh: true });
  assert.equal(scheduler.hasPendingWork(), true);

  scheduler.invalidate();

  assert.equal(scheduler.hasPendingWork(), false);
  request.resolve(translationState([0], 0));
});

test('Continue preserves the first attempt of an active sibling for its automatic retry', async () => {
  const requests = new Map([
    [0, [deferred()]],
    [1, [deferred(), deferred(), deferred()]],
    [2, [deferred(), deferred()]]
  ]);
  const attempts = new Map();
  const started = [];
  const errors = [];
  const scheduler = createArticleTranslationScheduler({
    requestBatch(batch) {
      const attempt = attempts.get(batch.index) || 0;
      attempts.set(batch.index, attempt + 1);
      started.push(batch.index);
      return requests.get(batch.index)[attempt].promise;
    },
    onBatch() {},
    onError(error) {
      errors.push(error.message);
    }
  });
  const retryableError = message => {
    const error = new Error(message);
    error.code = 'TRANSLATION_TIMEOUT';
    return error;
  };

  scheduler.start(translationState());
  requests.get(0)[0].resolve(translationState([0], 0));
  await flush();
  assert.deepEqual(started, [0, 1, 2]);

  requests.get(1)[0].reject(retryableError('batch one first failure'));
  await flush();
  assert.deepEqual(started, [0, 1, 2, 1]);
  requests.get(1)[1].reject(retryableError('batch one exhausted'));
  await flush();
  assert.deepEqual(errors, ['batch one exhausted']);

  scheduler.start(translationState([0]));
  assert.deepEqual(started, [0, 1, 2, 1, 1]);

  requests.get(2)[0].reject(retryableError('sibling first failure'));
  await flush();
  assert.deepEqual(started, [0, 1, 2, 1, 1, 2]);
  assert.deepEqual(errors, ['batch one exhausted']);

  requests.get(2)[1].reject(retryableError('sibling exhausted'));
  await flush();
  assert.equal(started.filter(index => index === 2).length, 2);
  assert.deepEqual(errors, ['batch one exhausted', 'sibling exhausted']);

  scheduler.invalidate();
  requests.get(1)[2].resolve(translationState([0, 1], 1));
});
