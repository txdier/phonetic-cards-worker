import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_FIRST_BATCH_TARGET,
  ARTICLE_MAX_PARAGRAPHS_PER_BATCH,
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

test('article translation caps tiny paragraphs to a D1-safe statement count', () => {
  const paragraphs = Array.from({ length: 100 }, (_, index) => ({ index, text: 'x' }));
  const batches = createArticleTranslationBatches(paragraphs);
  assert.equal(ARTICLE_MAX_PARAGRAPHS_PER_BATCH, 31);
  assert.ok(batches.every(
    batch => batch.paragraphs.length <= ARTICLE_MAX_PARAGRAPHS_PER_BATCH
  ));
  assert.deepEqual(batches.flatMap(batch => batch.paragraphIndexes), paragraphs.map(item => item.index));
});

test('article translation reserves the full D1 budget for consistency retries', () => {
  const worstCaseStatements = 1 + 6 + 2 + 1
    + (3 + ARTICLE_MAX_PARAGRAPHS_PER_BATCH) + 6;
  assert.equal(worstCaseStatements, 50);
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
