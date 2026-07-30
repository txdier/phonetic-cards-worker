const PREFIX = 'pc-aloud-checkpoint';

export function bodyFingerprint(body) {
  const text = String(body ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createAloudCheckpointStore({
  storage, username, now = () => Date.now()
} = {}) {
  const keyFor = articleId =>
    `${PREFIX}:${encodeURIComponent(String(username))}:${encodeURIComponent(String(articleId))}`;
  return {
    load({ articleId, body }) {
      try {
        const value = JSON.parse(storage?.getItem(keyFor(articleId)) || 'null');
        if (
          !value ||
          value.articleId !== String(articleId) ||
          value.bodyFingerprint !== bodyFingerprint(body) ||
          !Number.isInteger(value.sentenceIndex) ||
          value.sentenceIndex < 0 ||
          !Number.isFinite(value.offsetSeconds) ||
          value.offsetSeconds < 0 ||
          (value.state !== 'speaking' && value.state !== 'paused')
        ) return null;
        return { ...value };
      } catch {
        return null;
      }
    },
    save({ articleId, body, sentenceIndex, offsetSeconds, state }) {
      if (
        !articleId ||
        !Number.isInteger(sentenceIndex) ||
        sentenceIndex < 0 ||
        !Number.isFinite(offsetSeconds) ||
        offsetSeconds < 0
      ) return false;
      if (typeof storage?.setItem !== 'function') return false;
      try {
        storage.setItem(keyFor(articleId), JSON.stringify({
          articleId: String(articleId),
          bodyFingerprint: bodyFingerprint(body),
          sentenceIndex,
          offsetSeconds,
          state: state === 'speaking' ? 'speaking' : 'paused',
          savedAt: now()
        }));
        return true;
      } catch {
        return false;
      }
    },
    clear(articleId) {
      if (typeof storage?.removeItem !== 'function') return false;
      try {
        storage.removeItem(keyFor(articleId));
        return true;
      } catch {
        return false;
      }
    }
  };
}
