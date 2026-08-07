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
