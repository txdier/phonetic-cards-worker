export function createArticleTranslationScheduler({ requestBatch, onBatch, onError }) {
  const retryableCodes = new Set([
    'TRANSLATION_TIMEOUT',
    'TRANSLATION_UNAVAILABLE',
    'TRANSLATION_FORMAT_INVALID'
  ]);
  let generation = 0;
  let active = 0;
  let queue = [];
  let suspended = true;
  let stopped = false;
  let suspendedByError = false;
  let state = null;
  let refresh = false;
  let waitingForFirstBatch = false;
  const activeBatchIndexes = new Set();
  const attemptsByBatch = new Map();

  function completedBatchIndexes(nextState = state) {
    return new Set(
      (nextState?.batches || [])
        .filter(batch => batch.completed)
        .map(batch => batch.index)
    );
  }

  function schedulableBatches(batches) {
    const seen = new Set();
    return (batches || []).filter(batch => {
      if (seen.has(batch.index)) return false;
      seen.add(batch.index);
      return (refresh || !batch.completed) && !activeBatchIndexes.has(batch.index);
    });
  }

  function nextQueuedBatch() {
    const completed = refresh ? new Set() : completedBatchIndexes();
    while (queue.length) {
      const batch = queue.shift();
      if (activeBatchIndexes.has(batch.index)) continue;
      if (completed.has(batch.index)) continue;
      return batch;
    }
    return null;
  }

  function settle(batch, requestGeneration) {
    if (requestGeneration !== generation) return false;
    active -= 1;
    activeBatchIndexes.delete(batch.index);
    return true;
  }

  function run(batch) {
    const requestGeneration = generation;
    const requestState = state;
    const requestRefresh = refresh;
    attemptsByBatch.set(batch.index, (attemptsByBatch.get(batch.index) || 0) + 1);
    active += 1;
    activeBatchIndexes.add(batch.index);

    function fail(error) {
      if (!settle(batch, requestGeneration)) return;
      if (error?.code === 'TRANSLATION_DAILY_LIMIT') {
        stopped = true;
        queue = [];
        onError(error, { terminal: true });
        return;
      }
      if (
        retryableCodes.has(error?.code)
        && attemptsByBatch.get(batch.index) < 2
        && !suspended
        && !stopped
      ) {
        queue.unshift(batch);
        pump();
        return;
      }
      suspended = true;
      suspendedByError = true;
      onError(error);
    }

    let request;
    try {
      request = requestBatch(batch, requestState, requestRefresh);
    } catch (error) {
      fail(error);
      return false;
    }

    Promise.resolve(request).then(result => {
      if (!settle(batch, requestGeneration)) return;
      state = result;
      if (batch.index === 0) waitingForFirstBatch = false;
      onBatch(result);
      if (!refresh) {
        const completed = completedBatchIndexes(result);
        queue = queue.filter(queued => !completed.has(queued.index));
      }
      pump();
    }, error => {
      fail(error);
    });
    return true;
  }

  function pump() {
    if (suspended || stopped) return;
    const limit = waitingForFirstBatch ? 1 : 2;
    while (active < limit) {
      const batch = nextQueuedBatch();
      if (!batch || !run(batch)) break;
    }
  }

  function start(nextState, options = {}) {
    if (options.refresh === true) {
      generation += 1;
      active = 0;
      activeBatchIndexes.clear();
      attemptsByBatch.clear();
    } else if (suspendedByError) {
      attemptsByBatch.clear();
    }
    state = nextState;
    refresh = options.refresh === true;
    suspended = false;
    stopped = false;
    suspendedByError = false;
    queue = schedulableBatches(state?.batches);
    const firstBatch = queue.find(batch => batch.index === 0);
    waitingForFirstBatch = Boolean(firstBatch || activeBatchIndexes.has(0));
    if (firstBatch) {
      queue = [firstBatch, ...queue.filter(batch => batch !== firstBatch)];
    }
    pump();
  }

  function suspend() {
    suspended = true;
  }

  function invalidate() {
    generation += 1;
    active = 0;
    queue = [];
    suspended = true;
    state = null;
    activeBatchIndexes.clear();
    attemptsByBatch.clear();
    stopped = false;
    suspendedByError = false;
  }

  return { start, suspend, invalidate };
}
