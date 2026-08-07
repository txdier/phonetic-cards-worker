import { splitArticleParagraphs } from '../public/lib/text.js';
import { createArticleTranslationBatches } from './article-translation-batches.js';

export const ARTICLE_TRANSLATION_RULES_VERSION = 'article-v2-progressive';

export async function loadArticleTranslationState(DB, article, userId, consistencyAttempt = 0) {
  const { sourceHash, paragraphs, batches } = await createArticleTranslationPlan(article);
  const metadata = await DB.prepare(`
      SELECT title_zh, model, updated_at, source_hash, rules_version, run_token
      FROM article_translation_progress
      WHERE article_id = ? AND user_id = ? AND source_hash = ? AND rules_version = ?
    `).bind(article.id, userId, sourceHash, ARTICLE_TRANSLATION_RULES_VERSION).first();
  const runToken = metadata?.run_token ?? `base-${sourceHash}`;
  const { results: rows } = await DB.prepare(`
      SELECT paragraph_index, translation_zh
      FROM article_translation_paragraphs
      WHERE article_id = ? AND user_id = ? AND source_hash = ? AND rules_version = ?
        AND run_token = ?
      ORDER BY paragraph_index
    `).bind(
    article.id, userId, sourceHash, ARTICLE_TRANSLATION_RULES_VERSION, runToken
  ).all();
  const currentMetadata = await DB.prepare(`
    SELECT source_hash, rules_version, run_token
    FROM article_translation_progress WHERE article_id = ? AND user_id = ?
  `).bind(article.id, userId).first();
  if (
    (currentMetadata?.source_hash || '') !== (metadata?.source_hash || '')
    || (currentMetadata?.rules_version || '') !== (metadata?.rules_version || '')
    || (currentMetadata?.run_token ?? '') !== (metadata?.run_token ?? '')
  ) {
    if (consistencyAttempt < 1) {
      return loadArticleTranslationState(DB, article, userId, consistencyAttempt + 1);
    }
    return emptyArticleTranslationState(sourceHash, batches);
  }
  const paragraphIndexes = new Set(paragraphs.map(paragraph => paragraph.index));
  const translated = rows
    .map(row => ({ index: Number(row.paragraph_index), translation: row.translation_zh }))
    .filter(paragraph => paragraphIndexes.has(paragraph.index));
  const translatedIndexes = new Set(translated.map(paragraph => paragraph.index));
  const publicBatches = batches.map(batch => ({
    index: batch.index,
    paragraphIndexes: batch.paragraphIndexes,
    completed: batch.paragraphIndexes.every(index => translatedIndexes.has(index))
      && (batch.index !== 0 || Boolean(metadata?.title_zh?.trim()))
  }));
  const completedBatches = publicBatches.filter(batch => batch.completed).length;
  const status = !translated.length
    ? 'missing'
    : completedBatches === publicBatches.length ? 'fresh' : 'partial';

  return {
    status,
    sourceHash,
    rulesVersion: ARTICLE_TRANSLATION_RULES_VERSION,
    runToken,
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

function emptyArticleTranslationState(sourceHash, batches) {
  return {
    status: 'missing', sourceHash, rulesVersion: ARTICLE_TRANSLATION_RULES_VERSION,
    runToken: `base-${sourceHash}`, paragraphs: [],
    batches: batches.map(batch => ({
      index: batch.index, paragraphIndexes: batch.paragraphIndexes, completed: false
    })),
    completedBatches: 0, totalBatches: batches.length
  };
}

export async function createArticleTranslationPlan(article) {
  const sourceHash = await articleSourceHash(article.title, article.body);
  const paragraphs = splitArticleParagraphs(article.body).paragraphs
    .map(({ index, text }) => ({ index, text }));
  const batches = createArticleTranslationBatches(paragraphs);
  return { sourceHash, paragraphs, batches };
}

export async function articleSourceHash(title, body) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify({ title, body }))
  );
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}
