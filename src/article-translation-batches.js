export const ARTICLE_FIRST_BATCH_TARGET = 500;
export const ARTICLE_LATER_BATCH_MIN = 800;
export const ARTICLE_LATER_BATCH_MAX = 1200;

export function createArticleTranslationBatches(paragraphs) {
  const remaining = [...paragraphs];
  const batches = [];
  if (remaining.length) batches.push(takeBatch(remaining, ARTICLE_FIRST_BATCH_TARGET));
  while (remaining.length) batches.push(takeBatch(remaining, ARTICLE_LATER_BATCH_MAX));
  return batches.map((items, index) => ({
    index,
    paragraphIndexes: items.map(item => item.index),
    paragraphs: items
  }));
}

function takeBatch(remaining, limit) {
  const batch = [];
  let length = 0;
  while (remaining.length) {
    const nextLength = Array.from(remaining[0].text).length;
    if (batch.length && length + nextLength > limit) break;
    batch.push(remaining.shift());
    length += nextLength;
    if (nextLength > limit) break;
  }
  return batch;
}
