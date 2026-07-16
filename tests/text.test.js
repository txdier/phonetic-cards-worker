import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTerm,
  splitSentences,
  validateSelection,
  findTermMatches,
  containsNormalizedTerm
} from '../public/lib/text.js';

test('normalizes case and internal whitespace', () => {
  assert.equal(normalizeTerm('  Take   Part In  '), 'take part in');
});

test('rejects cross-sentence selection', () => {
  assert.deepEqual(
    validateSelection({ text: 'end. Next', startSentence: 0, endSentence: 1 }),
    { ok: false, code: 'CROSS_SENTENCE', reason: 'cross-sentence' }
  );
});

test('rejects selection when either endpoint cannot be mapped to a sentence', () => {
  assert.deepEqual(
    validateSelection({ text: 'deploy', startSentence: null, endSentence: null }),
    { ok: false, code: 'INVALID_SENTENCE', reason: 'invalid-sentence' }
  );
  assert.deepEqual(
    validateSelection({ text: 'deploy', startSentence: 0, endSentence: undefined }),
    { ok: false, code: 'INVALID_SENTENCE', reason: 'invalid-sentence' }
  );
});

test('accepts English text after trimming edge punctuation', () => {
  assert.deepEqual(
    validateSelection({ text: ' “Take   Part In!” ', startSentence: 2, endSentence: 2 }),
    { ok: true, displayText: 'Take   Part In', normalizedText: 'take part in' }
  );
});

test('rejects a selection without English text', () => {
  assert.deepEqual(
    validateSelection({ text: '“你好！”', startSentence: 0, endSentence: 0 }),
    { ok: false, code: 'NO_ENGLISH_TEXT', reason: 'no-letters' }
  );
});

test('distinguishes punctuation-only selections after trimming', () => {
  assert.deepEqual(
    validateSelection({ text: '“...!”', startSentence: 0, endSentence: 0 }),
    { ok: false, code: 'EMPTY_SELECTION', reason: 'empty-after-trim' }
  );
});

test('uses an injected sentence segmenter and preserves source spans', () => {
  const segmenter = {
    segment() {
      return [
        { index: 0, segment: 'First. ' },
        { index: 7, segment: 'Second!' }
      ];
    }
  };

  assert.deepEqual(splitSentences('First. Second!', segmenter), [
    { index: 0, start: 0, end: 7, text: 'First. ' },
    { index: 1, start: 7, end: 14, text: 'Second!' }
  ]);
});

test('falls back deterministically at English sentence punctuation', () => {
  const noSegmenter = { segment: null };

  assert.deepEqual(splitSentences('First!  Second?\nThird. Last', noSegmenter), [
    { index: 0, start: 0, end: 8, text: 'First!  ' },
    { index: 1, start: 8, end: 16, text: 'Second?\n' },
    { index: 2, start: 16, end: 23, text: 'Third. ' },
    { index: 3, start: 23, end: 27, text: 'Last' }
  ]);
});

test('prefers the longest non-overlapping term', () => {
  const matches = findTermMatches('We take part in class.', [
    { id: 'take', normalizedText: 'take', status: 'pending' },
    { id: 'phrase', normalizedText: 'take part in', status: 'word' }
  ]);
  assert.deepEqual(matches.map(({ id, text }) => ({ id, text })), [
    { id: 'phrase', text: 'take part in' }
  ]);
});

test('returns accepted matches in source order with payload intact', () => {
  const payload = { zh: '参加' };
  const matches = findTermMatches('Beta, alpha beta.', [
    { id: 'alpha-beta', normalizedText: 'alpha beta', status: 'word', payload },
    { id: 'beta', normalizedText: 'beta', status: 'pending' }
  ]);

  assert.deepEqual(matches, [
    { id: 'beta', normalizedText: 'beta', status: 'pending', start: 0, end: 4, text: 'Beta' },
    { id: 'alpha-beta', normalizedText: 'alpha beta', status: 'word', payload, start: 6, end: 16, text: 'alpha beta' }
  ]);
});

test('word state wins over identical pending state', () => {
  const [match] = findTermMatches('Deploy now.', [
    { id: 'p1', normalizedText: 'deploy', status: 'pending' },
    { id: 'w1', normalizedText: 'deploy', status: 'word', payload: { zh: '部署' } }
  ]);
  assert.equal(match.status, 'word');
  assert.equal(match.id, 'w1');
});

test('respects English boundaries', () => {
  assert.equal(containsNormalizedTerm('An article.', 'art'), false);
  assert.equal(containsNormalizedTerm('Art matters.', 'art'), true);
  assert.equal(containsNormalizedTerm('We take\tpart\nin class.', 'take part in'), true);
});

test('does not treat an empty normalized term as a match', () => {
  assert.equal(containsNormalizedTerm('Anything', '   '), false);
  assert.deepEqual(findTermMatches('Anything', [{ id: 'empty', normalizedText: '' }]), []);
});
