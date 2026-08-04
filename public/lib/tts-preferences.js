export const TTS_PREFERENCES_KEY = 'pc-tts-preferences';
const TTS_PREFERENCES_UPDATED_KEY = `${TTS_PREFERENCES_KEY}:updated-at`;
const USER_PREFERENCES_PATH = '/api/user-preferences';

export const TTS_PROFILE_OPTIONS = Object.freeze({
  'jenny-chat': 'Jenny · 轻松口语',
  'jenny-friendly': 'Jenny · 亲切通用',
  'aria-narration': 'Aria · 专业叙事',
  'guy-news': 'Guy · 沉稳新闻'
});

export const DEFAULT_TTS_PREFERENCES = Object.freeze({
  wordProfile: 'jenny-chat',
  articleProfile: 'aria-narration'
});

let pendingPreferences = null;
let pendingStorage = null;
let syncPromise = null;

export function loadTtsPreferences(storage) {
  try {
    const value = JSON.parse(storage?.getItem?.(TTS_PREFERENCES_KEY) || 'null');
    if (isValid(value)) return { ...value };
  } catch {
    // Storage can be unavailable or corrupt.
  }
  return { ...DEFAULT_TTS_PREFERENCES };
}

export function saveTtsPreferences(storage, preferences) {
  if (!isValid(preferences)) return false;
  try {
    const savedAt = Date.now();
    storage?.setItem?.(TTS_PREFERENCES_KEY, JSON.stringify(preferences));
    storage?.setItem?.(TTS_PREFERENCES_UPDATED_KEY, String(savedAt));
    pendingPreferences = { ...preferences };
    pendingStorage = storage || pendingStorage;
    if (canAutoSync()) void flushPendingPreferences();
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}

export async function syncTtsPreferences(storage = safeLocalStorage()) {
  if (!storage || typeof fetch !== 'function') return false;
  let local = null;
  let localUpdatedAt = 0;
  try {
    const value = JSON.parse(storage.getItem(TTS_PREFERENCES_KEY) || 'null');
    if (isValid(value)) local = { ...value };
    localUpdatedAt = Number(storage.getItem(TTS_PREFERENCES_UPDATED_KEY) || 0);
  } catch {
    local = null;
    localUpdatedAt = 0;
  }

  let response;
  try {
    response = await fetch(USER_PREFERENCES_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' }
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  let remote;
  try {
    remote = await response.json();
  } catch {
    return false;
  }
  const remotePreferences = isValid(remote?.ttsPreferences)
    ? { ...remote.ttsPreferences }
    : null;
  const remoteUpdatedAt = Number(remote?.updatedAt || 0);

  if (local && (!remotePreferences || localUpdatedAt > remoteUpdatedAt)) {
    pendingPreferences = local;
    pendingStorage = storage;
    return flushPendingPreferences();
  }
  if (!remotePreferences) return false;

  // The server won the timestamp comparison. Discard any older offline write
  // still waiting in memory before applying the remote value locally.
  pendingPreferences = null;
  if (pendingStorage === storage) pendingStorage = null;
  try {
    storage.setItem(TTS_PREFERENCES_KEY, JSON.stringify(remotePreferences));
    storage.setItem(
      TTS_PREFERENCES_UPDATED_KEY,
      String(remoteUpdatedAt || Date.now())
    );
    return true;
  } catch {
    return false;
  }
}

async function flushPendingPreferences() {
  if (!pendingPreferences || typeof fetch !== 'function') return false;
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    while (pendingPreferences) {
      const next = pendingPreferences;
      const storage = pendingStorage;
      pendingPreferences = null;
      try {
        const response = await fetch(USER_PREFERENCES_PATH, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ttsPreferences: next })
        });
        if (!response.ok) {
          pendingPreferences = pendingPreferences || next;
          pendingStorage = pendingStorage || storage;
          return false;
        }
        const result = await response.json().catch(() => ({}));
        updateServerTimestamp(storage, next, result?.updatedAt);
      } catch {
        pendingPreferences = pendingPreferences || next;
        pendingStorage = pendingStorage || storage;
        return false;
      }
    }
    pendingStorage = null;
    return true;
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

function updateServerTimestamp(storage, preferences, updatedAt) {
  const timestamp = Number(updatedAt);
  if (!storage || !Number.isFinite(timestamp) || timestamp <= 0) return;
  try {
    const current = JSON.parse(storage.getItem(TTS_PREFERENCES_KEY) || 'null');
    if (!samePreferences(current, preferences)) return;
    storage.setItem(TTS_PREFERENCES_UPDATED_KEY, String(timestamp));
  } catch {
    // A timestamp sync failure must not undo the saved preference.
  }
}

function samePreferences(left, right) {
  return Boolean(
    isValid(left)
    && isValid(right)
    && left.wordProfile === right.wordProfile
    && left.articleProfile === right.articleProfile
  );
}

function canAutoSync() {
  return Boolean(
    typeof fetch === 'function'
    && typeof globalThis.location?.origin === 'string'
  );
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isValid(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.hasOwn(TTS_PROFILE_OPTIONS, value.wordProfile)
    && Object.hasOwn(TTS_PROFILE_OPTIONS, value.articleProfile)
  );
}
