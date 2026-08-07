import { splitArticleParagraphs } from '../public/lib/text.js';
import { createArticleTranslationBatches } from './article-translation-batches.js';

export const ARTICLE_TRANSLATION_RULES_VERSION = 'article-v2-progressive';

export async function loadArticleTranslationState(DB, article, userId) {
  const sourceHash = await articleSourceHash(article.title, article.body);
  const paragraphs = splitArticleParagraphs(article.body).paragraphs
    .map(({ index, text }) => ({ index, text }));
  const batches = createArticleTranslationBatches(paragraphs);
  const [metadata, { results: rows }] = await Promise.all([
    DB.prepare(`
      SELECT title_zh, model, updated_at
      FROM article_translation_progress
      WHERE article_id = ? AND user_id = ? AND source_hash = ? AND rules_version = ?
    `).bind(article.id, userId, sourceHash, ARTICLE_TRANSLATION_RULES_VERSION).first(),
    DB.prepare(`
      SELECT paragraph_index, translation_zh
      FROM article_translation_paragraphs
      WHERE article_id = ? AND user_id = ? AND source_hash = ? AND rules_version = ?
      ORDER BY paragraph_index
    `).bind(article.id, userId, sourceHash, ARTICLE_TRANSLATION_RULES_VERSION).all()
  ]);
  const paragraphIndexes = new Set(paragraphs.map(paragraph => paragraph.index));
  const translated = rows
    .map(row => ({ index: Number(row.paragraph_index), translation: row.translation_zh }))
    .filter(paragraph => paragraphIndexes.has(paragraph.index));
  const translatedIndexes = new Set(translated.map(paragraph => paragraph.index));
  const publicBatches = batches.map(batch => ({
    index: batch.index,
    paragraphIndexes: batch.paragraphIndexes,
    completed: batch.paragraphIndexes.every(index => translatedIndexes.has(index))
  }));
  const completedBatches = publicBatches.filter(batch => batch.completed).length;
  const status = !translated.length
    ? 'missing'
    : completedBatches === publicBatches.length ? 'fresh' : 'partial';

  return {
    status,
    sourceHash,
    rulesVersion: ARTICLE_TRANSLATION_RULES_VERSION,
    ...(metadata ? {
      titleZh: metadata.title_zh || '',
      model: metadata.model,
      updatedAt: Number(metadata.updated_at)
    } : {}),
    paragraphs: translated,
    batches: publicBatches,
    completedBatches,
    totalBatches: publicBatches.length
  };
}

export async function articleSourceHash(title, body) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify({ title, body }))
  );
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}
