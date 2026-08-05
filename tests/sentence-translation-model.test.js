import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSentenceTranslation,
  parseTranslationResult,
  SENTENCE_TRANSLATION_MODEL
} from '../src/sentence-translation-model.js';

test('sentence translation uses the compact non-reasoning model request', async () => {
  const calls = [];
  const translation = await generateSentenceTranslation({
    AI: {
      async run(model, input, options) {
        calls.push({ model, input, options });
        return { response: '这是自然译文。' };
      }
    }
  }, '目标句："Fine."');

  assert.equal(translation, '这是自然译文。');
  assert.equal(SENTENCE_TRANSLATION_MODEL, '@cf/meta/llama-3.2-3b-instruct');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, SENTENCE_TRANSLATION_MODEL);
  assert.equal(calls[0].input.max_tokens, 192);
  assert.equal(calls[0].input.temperature, 0);
  assert.equal('max_completion_tokens' in calls[0].input, false);
  assert.equal('response_format' in calls[0].input, false);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('sentence translation honors its shorter dedicated timeout', async () => {
  let signal;
  await assert.rejects(
    generateSentenceTranslation({
      SENTENCE_TRANSLATION_TIMEOUT_MS: '1',
      AI: {
        run(_model, _input, options) {
signal = options.signal;
return new Promise(() => {});
        }
      }
    }, '目标句："Fine."'),
    error => error.translationCode === 'TRANSLATION_TIMEOUT'
      && error.httpStatus === 504
  );
  assert.equal(signal.aborted, true);
});

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
    parseTranslationResult({ response: 'Result: {"translatedText":"另一条译文"}' }),
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
