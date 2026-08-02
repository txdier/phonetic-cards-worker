export const TTS_PREFERENCES_KEY = 'pc-tts-preferences';

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
    storage?.setItem?.(TTS_PREFERENCES_KEY, JSON.stringify(preferences));
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}

function isValid(value) {
  return Boolean(
    value && typeof value === 'object'
    && Object.hasOwn(TTS_PROFILE_OPTIONS, value.wordProfile)
    && Object.hasOwn(TTS_PROFILE_OPTIONS, value.articleProfile)
  );
}
