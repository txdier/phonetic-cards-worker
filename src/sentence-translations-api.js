import { jsonResponse } from './http.js';
import { splitArticleParagraphs } from '../public/lib/text.js';
import {
  generatePlainTranslation,
  TRANSLATION_MODEL,
  TRANSLATION_RULES_VERSION,
  translationFailureResponse
} from './translation-api.js';

const SENTENCE_LIMIT = 2000;
const CONTEXT_LIMIT = 30000;
const LOOKUP_BATCH_SIZE = 50;
const LOOKUP_ITEM_LIMIT = 500;
const LOOKUP_AGGREGATE_LIMIT = 30000;

export async function handleSentenceTranslationsApi(request, env, path, userId) {
  const match = path.match(/^\/api\/articles\/([a-zA-Z0-9-]+)\/sentence-translations$/);
  if (!match) return notFound();
  try {
    if (request.method === 'GET') return await getSentenceTranslations(env.DB, match[1], userId);
    if (request.method === 'POST') {
      return await postSentenceTranslation(request, env, match[1], userId);
    }
    return notFound();
  } catch {
    return cacheUnavailable();
  }
}

async function getSentenceTranslations(DB, articleId, userId) {
  const article = await ownedArticle(DB, articleId, userId);
  if (!article) return articleNotFound();
  const paragraphs = splitArticleParagraphs(article.body).paragraphs;
  if (!descriptorsWithinLimits(paragraphs)) return tooLong();
  if (!lookupWithinLimits(paragraphs)) return lookupTooLarge();
  const items = await sentenceDescriptors(userId, paragraphs);
  const cached = await readCachedTranslations(DB, userId, items);
  return jsonResponse({
    sentences: items
      .filter(item => cached.has(item.identity.cacheKey))
      .map(item => ({
        sentenceIndex: item.sentenceIndex,
        sourceHash: item.identity.sourceHash,
        contextHash: item.identity.contextHash,
        translation: cached.get(item.identity.cacheKey)
      }))
  });
}

async function postSentenceTranslation(request, env, articleId, userId) {
  const body = await readObject(request);
  if (!validRequestBody(body)) return invalidInput();

  const article = await ownedArticle(env.DB, articleId, userId);
  if (!article) return articleNotFound();
  const item = await sentenceDescriptor(userId, article.body, body.sentenceIndex);
  if (!item) return invalidInput();
  if (!item.identity.sentence) return invalidInput();
  if (
    Array.from(item.identity.sentence).length > SENTENCE_LIMIT
    || Array.from(item.identity.paragraph).length > CONTEXT_LIMIT
  ) return tooLong();
  if (body.sourceHash !== item.identity.sourceHash) return sourceChanged();

  if (body.refresh !== true) {
    const cached = await readCachedTranslations(env.DB, userId, [item]);
    if (cached.has(item.identity.cacheKey)) {
      return sentenceResponse(item, cached.get(item.identity.cacheKey), true);
    }
  }

  const prompt = [
    `Target sentence: ${JSON.stringify(item.identity.sentence)}`,
    `Complete paragraph context: ${JSON.stringify(item.identity.paragraph)}`,
    'Use the complete paragraph only to resolve context. Translate only the target sentence into natural Simplified Chinese.'
  ].join('\n');
  let translation;
  try {
    translation = await generatePlainTranslation(env, prompt);
  } catch (error) {
    return translationFailureResponse(error);
  }

  const now = Date.now();
  const saved = await env.DB.prepare(`
    INSERT INTO sentence_translation_cache
      (user_id, cache_key, source_hash, context_hash, sentence_text,
       translation_zh, model, rules_version, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM articles
    WHERE id = ? AND user_id = ? AND body = ?
    ON CONFLICT(user_id, cache_key) DO UPDATE SET
      source_hash = excluded.source_hash,
      context_hash = excluded.context_hash,
      sentence_text = excluded.sentence_text,
      translation_zh = excluded.translation_zh,
      model = excluded.model,
      rules_version = excluded.rules_version,
      updated_at = excluded.updated_at
  `).bind(
    userId, item.identity.cacheKey, item.identity.sourceHash, item.identity.contextHash,
    item.identity.sentence, translation, TRANSLATION_MODEL, TRANSLATION_RULES_VERSION,
    now, now, articleId, userId, article.body
  ).run();
  if (!saved.meta.changes) return sourceChanged();
  return sentenceResponse(item, translation, false);
}

async function ownedArticle(DB, articleId, userId) {
  return DB.prepare(`
    SELECT id, body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
}

async function sentenceDescriptors(userId, paragraphs) {
  const sources = [];
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.sentences) {
      sources.push({
        sentenceIndex: sentence.index,
        sentence: sentence.text,
        paragraph: paragraph.text
      });
    }
  }
  const items = [];
  for (let start = 0; start < sources.length; start += LOOKUP_BATCH_SIZE) {
    const batch = sources.slice(start, start + LOOKUP_BATCH_SIZE);
    items.push(...await Promise.all(batch.map(async source => ({
      sentenceIndex: source.sentenceIndex,
      identity: await identity(userId, source.sentence, source.paragraph)
    }))));
  }
  return items;
}

function descriptorsWithinLimits(paragraphs) {
  return paragraphs.every(paragraph => (
    Array.from(normalizeSource(paragraph.text)).length <= CONTEXT_LIMIT
    && paragraph.sentences.every(sentence => {
      const normalized = normalizeSource(sentence.text);
      return normalized && Array.from(normalized).length <= SENTENCE_LIMIT;
    })
  ));
}

function lookupWithinLimits(paragraphs) {
  let itemCount = 0;
  let aggregateLength = 0;
  for (const paragraph of paragraphs) {
    aggregateLength += Array.from(normalizeSource(paragraph.text)).length;
    itemCount += paragraph.sentences.length;
    if (itemCount > LOOKUP_ITEM_LIMIT || aggregateLength > LOOKUP_AGGREGATE_LIMIT) return false;
  }
  return true;
}

async function sentenceDescriptor(userId, articleBody, sentenceIndex) {
  const paragraphs = splitArticleParagraphs(articleBody).paragraphs;
  for (const paragraph of paragraphs) {
    const sentence = paragraph.sentences.find(candidate => candidate.index === sentenceIndex);
    if (sentence) {
      return {
        sentenceIndex,
        identity: await identity(userId, sentence.text, paragraph.text)
      };
    }
  }
  return null;
}

async function readCachedTranslations(DB, userId, items) {
  const cached = new Map();
  for (let start = 0; start < items.length; start += LOOKUP_BATCH_SIZE) {
    const batch = items.slice(start, start + LOOKUP_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const result = await DB.prepare(`
      SELECT cache_key, translation_zh
      FROM sentence_translation_cache
      WHERE user_id = ? AND cache_key IN (${placeholders})
    `).bind(userId, ...batch.map(item => item.identity.cacheKey)).all();
    for (const row of result.results || []) cached.set(row.cache_key, row.translation_zh);
  }
  return cached;
}

function normalizeSource(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function identity(userId, sentence, paragraph) {
  const normalizedSentence = normalizeSource(sentence);
  const normalizedParagraph = normalizeSource(paragraph);
  return {
    sentence: normalizedSentence,
    paragraph: normalizedParagraph,
    sourceHash: await sha256(normalizedSentence),
    contextHash: await sha256(normalizedParagraph),
    cacheKey: await sha256(JSON.stringify([
      userId, normalizedSentence, normalizedParagraph,
      TRANSLATION_MODEL, TRANSLATION_RULES_VERSION
    ]))
  };
}

function validRequestBody(body) {
  return Boolean(
    body
    && Number.isInteger(body.sentenceIndex)
    && body.sentenceIndex >= 0
    && typeof body.sourceHash === 'string'
    && /^[a-f0-9]{64}$/.test(body.sourceHash)
    && (body.refresh === undefined || typeof body.refresh === 'boolean')
  );
}

async function readObject(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sentenceResponse(item, translation, cached) {
  return jsonResponse({
    sentenceIndex: item.sentenceIndex,
    sourceHash: item.identity.sourceHash,
    contextHash: item.identity.contextHash,
    translation,
    cached
  });
}

function invalidInput() {
  return jsonResponse(
    { error: 'invalid translation input', code: 'INVALID_TRANSLATION_INPUT' },
    { status: 400 }
  );
}

function tooLong() {
  return jsonResponse(
    { error: 'translation input is too long', code: 'TRANSLATION_TOO_LONG' },
    { status: 413 }
  );
}

function lookupTooLarge() {
  return jsonResponse(
    { error: 'sentence translation lookup is too large', code: 'TRANSLATION_LOOKUP_TOO_LARGE' },
    { status: 413 }
  );
}

function cacheUnavailable() {
  return jsonResponse({
    error: 'sentence translation cache is temporarily unavailable',
    code: 'TRANSLATION_CACHE_UNAVAILABLE',
    retryable: true
  }, { status: 503 });
}

function sourceChanged() {
  return jsonResponse(
    { error: 'article changed during translation', code: 'TRANSLATION_SOURCE_CHANGED' },
    { status: 409 }
  );
}

function articleNotFound() {
  return jsonResponse(
    { error: 'article not found', code: 'ARTICLE_NOT_FOUND' },
    { status: 404 }
  );
}

function notFound() {
  return jsonResponse({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
}
