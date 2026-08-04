import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranslationResult } from '../src/sentence-translation-model.js';

test('sentence translation parser accepts strict JSON', () => {
  assert.equal(
    parseTranslationResult({ response: '{"translation":"这是译文"}' }),
    '这是译文'
  );
});

test('sentence translation parser accepts fenced or extended JSON', () => {
  assert.equal(
    parseTranslationResult({
      response: '```json\n{"translation":"自然译文","reason":"context"}\n```'
    }),
    '自然译文'
  );
  assert.equal(
    parseTranslationResult({
      response: 'Result: {"translatedText":"另一条译文"}'
    }),
    '另一条译文'
  );
});

test('sentence translation parser accepts a plain translation fallback', () => {
  assert.equal(
    parseTranslationResult({ response: '翻译：这是纯文本结果' }),
    '这是纯文本结果'
  );
});

test('sentence translation parser rejects empty and malformed structured output', () => {
  assert.equal(parseTranslationResult({ response: '' }), '');
  assert.equal(parseTranslationResult({ response: '{not-json}' }), '');
  assert.equal(parseTranslationResult({ response: '{"reason":"missing"}' }), '');
});
