export const READER_PREFERENCES_KEY = 'pc-reader-preferences';

export const DEFAULT_READER_PREFERENCES = Object.freeze({
  fontSize: 'medium',
  lineHeight: 'comfortable',
  measure: 'medium'
});

const VALUES = Object.freeze({
  fontSize: Object.freeze({ small: '17px', medium: '19px', large: '21px' }),
  lineHeight: Object.freeze({ compact: '1.7', comfortable: '1.9', loose: '2.1' }),
  measure: Object.freeze({ narrow: '640px', medium: '760px', wide: '880px' })
});

function isValid(preferences) {
  return Boolean(
    preferences && typeof preferences === 'object'
    && Object.hasOwn(VALUES.fontSize, preferences.fontSize)
    && Object.hasOwn(VALUES.lineHeight, preferences.lineHeight)
    && Object.hasOwn(VALUES.measure, preferences.measure)
  );
}

export function loadReaderPreferences(storage) {
  try {
    const preferences = JSON.parse(storage?.getItem?.(READER_PREFERENCES_KEY) || 'null');
    if (isValid(preferences)) return { ...preferences };
  } catch {
    // Storage can be unavailable or contain stale data.
  }
  return { ...DEFAULT_READER_PREFERENCES };
}

export function saveReaderPreferences(storage, preferences) {
  if (!isValid(preferences)) return false;
  try {
    storage?.setItem?.(READER_PREFERENCES_KEY, JSON.stringify(preferences));
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}

export function readerPreferenceStyles(preferences) {
  const selected = isValid(preferences) ? preferences : DEFAULT_READER_PREFERENCES;
  return {
    fontSize: VALUES.fontSize[selected.fontSize],
    lineHeight: VALUES.lineHeight[selected.lineHeight],
    maxWidth: VALUES.measure[selected.measure]
  };
}
