const MAX_TRANSLATION_LENGTH = 12000;

export const TRANSLATION_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    type: 'object',
    properties: {
      translation: { type: 'string' }
    },
    required: ['translation'],
    additionalProperties: false
  }
});

export function parseTranslationResult(result) {
  const direct = translationFromValue(result, 0);
  if (direct) return direct;

  for (const text of responseTextCandidates(result)) {
    const translation = parseTranslationText(text);
    if (translation) return translation;
  }
  return '';
}

function translationFromValue(value, depth) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const translation = translationFromValue(item, depth + 1);
      if (translation) return translation;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  if (typeof value.translation === 'string') {
    const translation = sanitize(value.translation);
    if (translation) return translation;
  }

  for (const key of ['response', 'result', 'data', 'message', 'content', 'output']) {
    if (!Object.hasOwn(value, key)) continue;
    const translation = translationFromValue(value[key], depth + 1);
    if (translation) return translation;
  }
  if (Array.isArray(value.choices)) {
    const translation = translationFromValue(value.choices, depth + 1);
    if (translation) return translation;
  }
  return '';
}

function responseTextCandidates(result) {
  const candidates = [];
  collectText(result, candidates, 0);
  return [...new Set(candidates.map(value => value.trim()).filter(Boolean))];
}

function collectText(value, candidates, depth) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    candidates.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, candidates, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  for (const key of ['response', 'output_text', 'text', 'content']) {
    if (Object.hasOwn(value, key)) collectText(value[key], candidates, depth + 1);
  }
  for (const key of ['choices', 'message', 'output', 'result', 'data']) {
    if (Object.hasOwn(value, key)) collectText(value[key], candidates, depth + 1);
  }
}

function parseTranslationText(value) {
  let text = stripReasoning(stripCodeFence(String(value || '').normalize('NFKC').trim()));
  if (!text) return '';

  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const translation = translationFromValue(parsed, 0);
      if (translation) return translation;
    } catch {
      // Keep checking other balanced JSON objects or the plain-text fallback.
    }
  }

  if (/^\s*[\[{]/.test(text) || /["']translation["']\s*:/i.test(text)) return '';

  text = text
    .replace(/^(?:the\s+)?(?:translation|translated text|final answer|译文(?:如下)?|翻译(?:如下)?|答案)\s*[:：]\s*/i, '')
    .replace(/^```(?:text)?\s*|\s*```$/gi, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .trim();
  return sanitize(text);
}

function stripCodeFence(value) {
  const match = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] || value).trim();
}

function stripReasoning(value) {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .trim();
}

function jsonObjectCandidates(value) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function sanitize(value) {
  const text = String(value || '').normalize('NFKC').trim();
  return text && Array.from(text).length <= MAX_TRANSLATION_LENGTH ? text : '';
}
