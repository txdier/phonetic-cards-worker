const EDGE_PUNCTUATION = /^[^A-Za-z]+|[^A-Za-z]+$/g;
const ENGLISH_LETTER = /[A-Za-z]/;

export function normalizeTerm(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function splitSentences(value, segmenter = null) {
  const text = String(value || '');
  if (!text) return [];

  const selectedSegmenter = segmenter === null ? createNativeSegmenter() : segmenter;
  if (selectedSegmenter && typeof selectedSegmenter.segment === 'function') {
    const spans = [];
    for (const { index: start, segment } of selectedSegmenter.segment(text)) {
      if (!segment.trim() && spans.length) {
        const previous = spans.at(-1);
        previous.end = start + segment.length;
        previous.text += segment;
        continue;
      }
      spans.push({ index: spans.length, start, end: start + segment.length, text: segment });
    }
    return spans;
  }

  return fallbackSentenceSpans(text);
}

export function validateSelection({ text, startSentence, endSentence }) {
  if (!Number.isInteger(startSentence) || !Number.isInteger(endSentence)) {
    return { ok: false, code: 'INVALID_SENTENCE' };
  }
  if (startSentence !== endSentence) return { ok: false, code: 'CROSS_SENTENCE' };
  const displayText = String(text || '').replace(EDGE_PUNCTUATION, '').trim();
  if (!ENGLISH_LETTER.test(displayText)) return { ok: false, code: 'NO_ENGLISH_TEXT' };
  return { ok: true, displayText, normalizedText: normalizeTerm(displayText) };
}

export function findTermMatches(value, entries) {
  const text = String(value || '');
  const candidates = (Array.isArray(entries) ? entries : [])
    .map((entry, order) => ({ entry, order, term: normalizeTerm(entry?.normalizedText) }))
    .filter(({ term }) => term)
    .sort(compareCandidates);
  const occupied = [];
  const matches = [];

  for (const candidate of candidates) {
    const pattern = createTermPattern(candidate.term, true);
    for (const result of text.matchAll(pattern)) {
      const start = result.index;
      const end = start + result[0].length;
      if (occupied.some(span => start < span.end && end > span.start)) continue;

      occupied.push({ start, end });
      matches.push({
        ...candidate.entry,
        start,
        end,
        text: result[0]
      });
    }
  }

  return matches.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function containsNormalizedTerm(value, normalizedTerm) {
  const term = normalizeTerm(normalizedTerm);
  if (!term) return false;
  return createTermPattern(term).test(String(value || ''));
}

function createNativeSegmenter() {
  if (typeof globalThis.Intl?.Segmenter !== 'function') return null;
  return new globalThis.Intl.Segmenter('en', { granularity: 'sentence' });
}

function fallbackSentenceSpans(text) {
  const spans = [];
  const sentenceEnd = /[.!?]+["')\]]*(?:\s+|$)/g;
  let start = 0;

  for (const match of text.matchAll(sentenceEnd)) {
    const end = match.index + match[0].length;
    spans.push({ index: spans.length, start, end, text: text.slice(start, end) });
    start = end;
  }

  if (start < text.length) {
    spans.push({ index: spans.length, start, end: text.length, text: text.slice(start) });
  }

  return spans;
}

function compareCandidates(left, right) {
  const wordDifference = wordCount(right.term) - wordCount(left.term);
  if (wordDifference) return wordDifference;

  const lengthDifference = right.term.length - left.term.length;
  if (lengthDifference) return lengthDifference;

  const statusDifference = statusPriority(right.entry?.status) - statusPriority(left.entry?.status);
  if (statusDifference) return statusDifference;

  return left.order - right.order;
}

function wordCount(term) {
  return term.split(' ').length;
}

function statusPriority(status) {
  return status === 'word' ? 1 : 0;
}

function createTermPattern(term, global = false) {
  const body = term.split(' ').map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![A-Za-z])${body}(?![A-Za-z])`, global ? 'gi' : 'i');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
