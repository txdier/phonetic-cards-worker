export const PROGRESS_QUEUE_KEY = 'pc-progress-queue';

export function progressQueueKey(username) {
  return `${PROGRESS_QUEUE_KEY}:${encodeURIComponent(String(username))}`;
}

function clampRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(1, ratio));
}

export function createReadingSession({ now = () => Date.now(), idleMs = 60_000 } = {}) {
  let visible = false;
  let lastInteraction = null;
  let accountedAt = now();
  let pendingActiveMs = 0;
  let positionRatio = 0;
  let topArmed = false;

  function accrue(until = now()) {
    if (visible && lastInteraction != null) {
      const activeEnd = Math.min(until, lastInteraction + idleMs);
      pendingActiveMs += Math.max(0, activeEnd - accountedAt);
    }
    accountedAt = until;
  }

  return {
    setVisible(nextVisible) {
      accrue();
      visible = Boolean(nextVisible);
    },
    interact() {
      const current = now();
      accrue(current);
      lastInteraction = current;
      accountedAt = current;
    },
    updatePosition(value) {
      positionRatio = clampRatio(value);
      let readCompleted = false;
      if (positionRatio <= 0.01) topArmed = true;
      else if (positionRatio >= 0.99 && topArmed) {
        topArmed = false;
        readCompleted = true;
      }
      return { positionRatio, readCompleted };
    },
    flushActiveMs() {
      accrue();
      const amount = Math.round(pendingActiveMs);
      pendingActiveMs = 0;
      return amount;
    },
    markReadAloudComplete() {
      return { readAloudCompleted: true };
    },
    snapshot() {
      return { visible, positionRatio, topArmed };
    }
  };
}

function readStored(storage, key) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactStoredPositions(items) {
  const seenArticles = new Set();
  const compacted = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'position' && typeof item.articleId === 'string') {
      if (seenArticles.has(item.articleId)) continue;
      seenArticles.add(item.articleId);
    }
    compacted.push(item);
  }
  return compacted.reverse();
}

function normalizeAloudOffsetSeconds(value) {
  const offsetSeconds = Number(value);
  if (!Number.isFinite(offsetSeconds)) return 0;
  return Math.max(0, offsetSeconds);
}

function normalizeProgressItem(item) {
  if (item?.kind !== 'position') return item;
  const hasSentenceIndex = Object.prototype.hasOwnProperty.call(item, 'lastAloudSentenceIndex');
  const hasOffset = Object.prototype.hasOwnProperty.call(item, 'lastAloudOffsetSeconds');
  if (!hasSentenceIndex && !hasOffset) return item;
  const sentenceIndex = Number.isInteger(item.lastAloudSentenceIndex) &&
    item.lastAloudSentenceIndex >= 0
    ? item.lastAloudSentenceIndex
    : null;
  return {
    ...item,
    lastAloudSentenceIndex: sentenceIndex,
    lastAloudOffsetSeconds: sentenceIndex === null
      ? 0
      : normalizeAloudOffsetSeconds(item.lastAloudOffsetSeconds)
  };
}

export function createProgressQueue({ storage, send, key = PROGRESS_QUEUE_KEY }) {
  let items = compactStoredPositions(readStored(storage, key)).map(normalizeProgressItem);
  let activeRetry = null;
  let inFlightItem = null;

  function persist() {
    try {
      if (items.length) storage?.setItem(key, JSON.stringify(items));
      else storage?.removeItem(key);
    } catch { /* storage may be disabled */ }
  }

  function retry() {
    if (activeRetry) return activeRetry;
    activeRetry = (async () => {
      while (items.length) {
        const item = items[0];
        inFlightItem = item;
        try {
          await send(item);
        } catch {
          return false;
        } finally {
          if (inFlightItem === item) inFlightItem = null;
        }
        const acknowledgedIndex = items.indexOf(item);
        if (acknowledgedIndex >= 0) items.splice(acknowledgedIndex, 1);
        persist();
      }
      return true;
    })().finally(() => {
      inFlightItem = null;
      activeRetry = null;
    });
    return activeRetry;
  }

  return {
    async submit(item) {
      const normalized = normalizeProgressItem(item);
      items.push(normalized);
      if (normalized?.kind === 'position' && typeof normalized.articleId === 'string') {
        items = compactStoredPositions(items);
      }
      persist();
      return retry();
    },
    replacePosition(item, { preserveLatestPositionRatio = false } = {}) {
      let position = normalizeProgressItem(item);
      if (position?.kind !== 'position' || typeof position.articleId !== 'string') {
        return Promise.reject(new Error('replacement must be an article position'));
      }
      if (preserveLatestPositionRatio) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const queued = items[index];
          if (queued?.kind !== 'position' || queued.articleId !== position.articleId) continue;
          position = {
            ...position,
            lastPositionRatio: clampRatio(queued.lastPositionRatio)
          };
          break;
        }
      }
      const retained = items.filter(queued =>
        queued?.kind !== 'position' || queued.articleId !== position.articleId
      );
      const capturedIndex = inFlightItem ? retained.indexOf(inFlightItem) : -1;
      retained.splice(capturedIndex + 1, 0, position);
      items = retained;
      persist();
      return retry();
    },
    retry,
    snapshot() { return items.map(item => ({ ...item })); }
  };
}

export function sendProgressItem(api, item) {
  const articleId = encodeURIComponent(item.articleId);
  if (item.kind === 'event') {
    return api(`/api/articles/${articleId}/progress/events`, {
      method: 'POST', body: JSON.stringify(item.event)
    });
  }
  if (item.kind === 'position') {
    const position = normalizeProgressItem(item);
    const body = { lastPositionRatio: position.lastPositionRatio };
    if (Object.prototype.hasOwnProperty.call(position, 'lastAloudSentenceIndex')) {
      body.lastAloudSentenceIndex = position.lastAloudSentenceIndex;
      body.lastAloudOffsetSeconds = position.lastAloudOffsetSeconds;
    }
    return api(`/api/articles/${articleId}/progress`, {
      method: 'PATCH', body: JSON.stringify(body)
    });
  }
  return Promise.reject(new Error('unknown progress queue item'));
}
