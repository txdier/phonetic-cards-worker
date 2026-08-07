import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_FIRST_BATCH_TARGET,
  ARTICLE_LATER_BATCH_MAX,
  createArticleTranslationBatches
} from '../src/article-translation-batches.js';

test('article translation gives the opening paragraph a small first batch', () => {
  const paragraphs = [
    { index: 0, text: 'a'.repeat(300) },
    { index: 1, text: 'b'.repeat(300) },
    { index: 2, text: 'c'.repeat(500) }
  ];
  const batches = createArticleTranslationBatches(paragraphs);
  assert.equal(ARTICLE_FIRST_BATCH_TARGET, 500);
  assert.deepEqual(batches.map(batch => batch.paragraphIndexes), [[0], [1, 2]]);
});

test('article translation keeps oversized natural paragraphs intact', () => {
  const paragraphs = [
    { index: 0, text: 'a'.repeat(700) },
    { index: 1, text: 'b'.repeat(ARTICLE_LATER_BATCH_MAX + 1) },
    { index: 2, text: 'c'.repeat(100) }
  ];
  assert.deepEqual(
    createArticleTranslationBatches(paragraphs).map(batch => batch.paragraphIndexes),
    [[0], [1], [2]]
  );
});
