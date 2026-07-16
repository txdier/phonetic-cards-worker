import { findTermMatches, normalizeTerm } from './text.js';

export function primaryWord(word) {
  return word?.lemma || word?.en || '';
}

export function distinctForms(word) {
  const normalizedLemma = normalizeTerm(primaryWord(word));
  const seen = new Set();
  const forms = [];
  for (const item of Array.isArray(word?.forms) ? word.forms : []) {
    const normalizedForm = normalizeTerm(item?.normalized_form || item?.form);
    if (!normalizedForm || normalizedForm === normalizedLemma || seen.has(normalizedForm)) continue;
    seen.add(normalizedForm);
    forms.push(String(item.form || '').trim());
  }
  return forms;
}

export function maskWordForms(example, word) {
  const text = String(example || '');
  const terms = [
    primaryWord(word),
    ...(Array.isArray(word?.forms) ? word.forms.map(item => item?.form) : [])
  ];
  const normalizedTerms = [...new Set(terms.map(normalizeTerm).filter(Boolean))];
  const matches = findTermMatches(
    text,
    normalizedTerms.map(normalizedText => ({ normalizedText }))
  );
  let masked = '';
  let cursor = 0;
  for (const match of matches) {
    masked += text.slice(cursor, match.start) + '_____';
    cursor = match.end;
  }
  return masked + text.slice(cursor);
}
