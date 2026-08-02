export const TRANSLATION_MODE_KEY = 'pc-reader-translation-mode';
export const TRANSLATION_MODES = Object.freeze(['original', 'sentence', 'full']);

export function loadTranslationMode(storage) {
  try {
    const mode = storage?.getItem?.(TRANSLATION_MODE_KEY);
    return TRANSLATION_MODES.includes(mode) ? mode : 'original';
  } catch {
    return 'original';
  }
}

export function saveTranslationMode(storage, mode) {
  if (!TRANSLATION_MODES.includes(mode)) return false;
  try {
    storage?.setItem?.(TRANSLATION_MODE_KEY, mode);
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}
