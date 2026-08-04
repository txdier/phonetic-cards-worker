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
    void flushPendingPreferences();
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
    return flushPendingPreferences();
  }
  if (!remotePreferences) return false;

  try {
    storage.setItem(TTS_PREFERENCES_KEY, JSON.stringify(remotePreferences));
    storage.setItem(TTS_PREFERENCES_UPDATED_KEY, String(remoteUpdatedAt || Date.now()));
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
          return false;
        }
      } catch {
        pendingPreferences = pendingPreferences || next;
        return false;
      }
    }
    return true;
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
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
    value && typeof value === 'object'
    && Object.hasOwn(TTS_PROFILE_OPTIONS, value.wordProfile)
    && Object.hasOwn(TTS_PROFILE_OPTIONS, value.articleProfile)
  );
}
