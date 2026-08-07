export function createArticleTranslationScheduler({ requestBatch, onBatch, onError }) {
  let generation = 0;
  let active = 0;
  let queue = [];
  let suspended = true;
  let state = null;
  let refresh = false;
  let waitingForFirstBatch = false;
  const activeBatchIndexes = new Set();

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
    active += 1;
    activeBatchIndexes.add(batch.index);

    let request;
    try {
      request = requestBatch(batch, requestState, requestRefresh);
    } catch (error) {
      if (settle(batch, requestGeneration)) onError(error);
      return false;
    }

    Promise.resolve(request).then(result => {
      if (!settle(batch, requestGeneration)) return;
      state = result;
      if (batch.index === 0) waitingForFirstBatch = false;
      onBatch(result);
      pump();
    }, error => {
      if (!settle(batch, requestGeneration)) return;
      onError(error);
    });
    return true;
  }

  function pump() {
    if (suspended) return;
    const limit = waitingForFirstBatch ? 1 : 2;
    while (active < limit && queue.length) {
      if (!run(queue.shift())) break;
    }
  }

  function start(nextState, options = {}) {
    state = nextState;
    refresh = options.refresh === true;
    suspended = false;
    queue = (state?.batches || []).filter(batch => (
      (refresh || !batch.completed) && !activeBatchIndexes.has(batch.index)
    ));
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
  }

  return { start, suspend, invalidate };
}
