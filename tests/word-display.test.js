import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distinctForms,
  maskWordForms,
  primaryWord
} from '../public/lib/word-display.js';

test('primaryWord prefers lemma and falls back to legacy en', () => {
  assert.equal(primaryWord({ lemma: 'deploy', en: 'deployed' }), 'deploy');
  assert.equal(primaryWord({ lemma: null, en: 'legacy' }), 'legacy');
});

test('distinctForms returns only recorded forms different from the lemma', () => {
  const word = {
    lemma: 'deploy',
    forms: [
      { form: 'Deploy', normalized_form: 'deploy' },
      { form: 'deployed', normalized_form: 'deployed' },
      { form: 'deploying', normalized_form: 'deploying' }
    ]
  };

  assert.deepEqual(distinctForms(word), ['deployed', 'deploying']);
});

test('maskWordForms fully hides an inflected recorded form', () => {
  const word = {
    lemma: 'deploy',
    forms: [{ form: 'deployed', normalized_form: 'deployed' }]
  };

  assert.equal(maskWordForms('They deployed it.', word), 'They _____ it.');
});

test('maskWordForms hides an irregular recorded form', () => {
  const word = {
    lemma: 'go',
    forms: [{ form: 'went', normalized_form: 'went' }]
  };

  assert.equal(maskWordForms('They went home.', word), 'They _____ home.');
});

test('maskWordForms escapes regex syntax in recorded words', () => {
  const word = { lemma: 'c++', forms: [] };

  assert.doesNotThrow(() => maskWordForms('Use c++ today.', word));
  assert.equal(maskWordForms('Use c++ today.', word), 'Use _____ today.');
});

test('maskWordForms matches longest-first with ASCII English boundaries', () => {
  const word = {
    lemma: 'take',
    forms: [{ form: 'take part', normalized_form: 'take part' }]
  };

  assert.equal(
    maskWordForms('We take part, but intake stays.', word),
    'We _____, but intake stays.'
  );
});
