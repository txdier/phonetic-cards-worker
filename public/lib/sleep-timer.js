function makeSnapshot(deadline, now, expired = false) {
  const remainingMs = deadline == null ? 0 : Math.max(0, deadline - now);
  return {
    active: deadline != null && remainingMs > 0,
    deadline: remainingMs > 0 ? deadline : null,
    remainingMs,
    expired
  };
}

export function createSleepTimer({
  storage,
  key,
  now = () => Date.now(),
  setInterval: startInterval = globalThis.setInterval,
  clearInterval: stopInterval = globalThis.clearInterval,
  tickMs = 1_000
} = {}) {
  const listeners = new Set();
  let deadline = loadDeadline();
  let intervalId = null;
  let tickerStarted = false;

  if (deadline != null) startTicker();

  function readNow() {
    return now();
  }

  function loadDeadline() {
    try {
      const value = JSON.parse(storage?.getItem?.(key) || 'null');
      if (Number.isFinite(value?.deadline) && value.deadline > readNow()) {
        return value.deadline;
      }
      if (value?.deadline != null) removeDeadline();
    } catch {
      // Storage can be unavailable or contain malformed data.
    }
    return null;
  }

  function saveDeadline() {
    try {
      storage?.setItem?.(key, JSON.stringify({ deadline }));
    } catch {
      // The in-memory timer still works when persistent storage is unavailable.
    }
  }

  function removeDeadline() {
    try {
      storage?.removeItem?.(key);
    } catch {
      // Removing a stale deadline is best effort.
    }
  }

  function publish(snapshot) {
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  function startTicker() {
    if (tickerStarted) return;
    tickerStarted = true;
    intervalId = startInterval(check, tickMs);
  }

  function stopTicker() {
    if (!tickerStarted) return;
    tickerStarted = false;
    stopInterval(intervalId);
    intervalId = null;
  }

  function check() {
    const currentTime = readNow();
    if (deadline == null) return makeSnapshot(null, currentTime);

    if (currentTime >= deadline) {
      deadline = null;
      stopTicker();
      removeDeadline();
      return publish(makeSnapshot(null, currentTime, true));
    }

    return publish(makeSnapshot(deadline, currentTime));
  }

  function setMinutes(minutes) {
    if (!Number.isInteger(minutes) || minutes <= 0) return false;
    deadline = readNow() + minutes * 60_000;
    saveDeadline();
    startTicker();
    publish(makeSnapshot(deadline, readNow()));
    return true;
  }

  function cancel() {
    deadline = null;
    stopTicker();
    removeDeadline();
    return publish(makeSnapshot(null, readNow()));
  }

  function snapshot() {
    return makeSnapshot(deadline, readNow());
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function cleanup() {
    stopTicker();
  }

  return { subscribe, setMinutes, cancel, check, snapshot, cleanup };
}
