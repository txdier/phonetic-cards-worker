import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranslationResult,
  TRANSLATION_RESPONSE_FORMAT
} from '../src/translation-result.js';

test('translation response format requests a single translation field', () => {
  assert.equal(TRANSLATION_RESPONSE_FORMAT.type, 'json_schema');
  assert.deepEqual(TRANSLATION_RESPONSE_FORMAT.json_schema.required, ['translation']);
  assert.equal(
    TRANSLATION_RESPONSE_FORMAT.json_schema.properties.translation.type,
    'string'
  );
});

test('translation parser accepts Workers AI response objects', () => {
  assert.equal(
    parseTranslationResult({ response: { translation: '部署；调配' } }),
    '部署；调配'
  );
  assert.equal(
    parseTranslationResult({ result: { response: { translation: '保持住' } } }),
    '保持住'
  );
});

test('translation parser accepts OpenAI choices and segmented content', () => {
  assert.equal(
    parseTranslationResult({
      choices: [{ message: { content: '{"translation":"搞定了"}' } }]
    }),
    '搞定了'
  );
  assert.equal(
    parseTranslationResult({
      choices: [{
        message: {
          content: [{ type: 'text', text: '{"translation":"继续前进"}' }]
        }
      }]
    }),
    '继续前进'
  );
});

test('translation parser accepts code fences reasoning tags and plain text', () => {
  assert.equal(
    parseTranslationResult({ response: '```json\n{"translation":"译文"}\n```' }),
    '译文'
  );
  assert.equal(
    parseTranslationResult({
      response: '<think>Need context.</think>\n{"translation":"上下文译文"}'
    }),
    '上下文译文'
  );
  assert.equal(
    parseTranslationResult({ response: '翻译：自然译文' }),
    '自然译文'
  );
});

test('translation parser rejects malformed or prose-wrapped structured output', () => {
  assert.equal(parseTranslationResult({ response: '{"translation":' }), '');
  assert.equal(
    parseTranslationResult({ response: '译文如下：{"translation":"部署"}' }),
    ''
  );
  assert.equal(parseTranslationResult({ response: '解释：这里是分析' }), '');
});
