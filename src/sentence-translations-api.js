import { jsonResponse } from './http.js';
import { splitArticleParagraphs } from '../public/lib/text.js';
import {
  TRANSLATION_MODEL,
  TRANSLATION_RULES_VERSION
} from './translation-api.js';
import {
  generateSentenceTranslation,
  sentenceTranslationFailureResponse
} from './sentence-translation-model.js';

const SENTENCE_LIMIT = 6000;
const PROMPT_CONTEXT_LIMIT = 6000;
const LOOKUP_BATCH_SIZE = 50;
const MAX_EXPLICIT_LOOKUP_LIMIT = 500;

export async function handleSentenceTranslationsApi(request, env, path, userId) {
  const match = path.match(/^\/api\/articles\/([a-zA-Z0-9-]+)\/sentence-translations$/);
  if (!match) return notFound();
  try {
    if (request.method === 'GET') {
      return await getSentenceTranslations(request, env.DB, match[1], userId);
    }
    if (request.method === 'POST') {
      return await postSentenceTranslation(request, env, match[1], userId);
    }
    return notFound();
  } catch {
    return cacheUnavailable();
  }
}

async function getSentenceTranslations(request, DB, articleId, userId) {
  const article = await ownedArticle(DB, articleId, userId);
  if (!article) return articleNotFound();
  const sources = sentenceSources(splitArticleParagraphs(article.body).paragraphs);
  const { cursor, limit } = lookupPage(request, sources.length);
  const selected = sources.slice(cursor, cursor + limit);
  const items = await sentenceDescriptors(userId, selected);
  const cached = await readCachedTranslations(DB, userId, items);
  return jsonResponse({
    sentences: items
      .filter(item => cached.has(item.identity.cacheKey))
      .map(item => ({
        sentenceIndex: item.sentenceIndex,
        sourceHash: item.identity.sourceHash,
        contextHash: item.identity.contextHash,
        translation: cached.get(item.identity.cacheKey)
      })),
    nextCursor: cursor + selected.length < sources.length
      ? cursor + selected.length
      : null,
    total: sources.length
  });
}

async function postSentenceTranslation(request, env, articleId, userId) {
  const body = await readObject(request);
  if (!validRequestBody(body)) return invalidInput();
  const article = await ownedArticle(env.DB, articleId, userId);
  if (!article) return articleNotFound();
  const item = await sentenceDescriptor(userId, article.body, body.sentenceIndex);
  if (!item || !item.identity.sentence) return invalidInput();
  if (Array.from(item.identity.sentence).length > SENTENCE_LIMIT) return tooLong();
  if (body.sourceHash !== item.identity.sourceHash) return sourceChanged();

  if (body.refresh !== true) {
    const cached = await readCachedTranslations(env.DB, userId, [item]);
    if (cached.has(item.identity.cacheKey)) {
      return sentenceResponse(item, cached.get(item.identity.cacheKey), true);
    }
  }

  const prompt = [
    `Target sentence: ${JSON.stringify(item.identity.sentence)}`,
    `Relevant paragraph context: ${JSON.stringify(
      contextWindow(
        item.identity.paragraph,
        item.identity.sentence,
        PROMPT_CONTEXT_LIMIT
      )
    )}`,
    'Translate only the target sentence into natural Simplified Chinese.'
  ].join('\n');
  let translation;
  try {
    translation = await generateSentenceTranslation(env, prompt);
  } catch (error) {
    return sentenceTranslationFailureResponse(error);
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
      translation_zh = excluded.translation_zh,
      updated_at = excluded.updated_at,
      source_hash = excluded.source_hash,
      context_hash = excluded.context_hash,
      sentence_text = excluded.sentence_text,
      model = excluded.model,
      rules_version = excluded.rules_version
  `).bind(
    userId,
    item.identity.cacheKey,
    item.identity.sourceHash,
    item.identity.contextHash,
    item.identity.sentence,
    translation,
    TRANSLATION_MODEL,
    TRANSLATION_RULES_VERSION,
    now,
    now,
    articleId,
    userId,
    article.body
  ).run();
  if (!saved.meta.changes) return sourceChanged();
  return sentenceResponse(item, translation, false);
}

async function ownedArticle(DB, articleId, userId) {
  return DB.prepare(`
    SELECT id, body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
}

function sentenceSources(paragraphs) {
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
  return sources;
}

async function sentenceDescriptors(userId, sources) {
  const items = [];
  for (let start = 0; start < sources.length; start += LOOKUP_BATCH_SIZE) {
    const batch = sources.slice(start, start + LOOKUP_BATCH_SIZE);
    items.push(...await Promise.all(batch.map(async source => ({
      sentenceIndex: source.sentenceIndex,
      identity: await identity(
        userId,
        source.sentence,
        source.paragraph
      )
    }))));
  }
  return items;
}

async function sentenceDescriptor(userId, body, index) {
  for (const paragraph of splitArticleParagraphs(body).paragraphs) {
    const sentence = paragraph.sentences.find(item => item.index === index);
    if (sentence) {
      return {
        sentenceIndex: index,
        identity: await identity(userId, sentence.text, paragraph.text)
      };
    }
  }
  return null;
}

async function readCachedTranslations(DB, userId, items) {
  const result = new Map();
  for (let start = 0; start < items.length; start += LOOKUP_BATCH_SIZE) {
    const batch = items.slice(start, start + LOOKUP_BATCH_SIZE);
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(', ');
    const rows = await DB.prepare(`
      SELECT cache_key, translation_zh
      FROM sentence_translation_cache
      WHERE user_id = ? AND cache_key IN (${placeholders})
    `).bind(
      userId,
      ...batch.map(item => item.identity.cacheKey)
    ).all();
    for (const row of rows.results || []) {
      result.set(row.cache_key, row.translation_zh);
    }
  }
  return result;
}

function contextWindow(paragraph, sentence, limit) {
  const text = normalizeSource(paragraph);
  if (Array.from(text).length <= limit) return text;

  const normalizedSentence = normalizeSource(sentence);
  const index = text.indexOf(normalizedSentence);
  if (index < 0) return Array.from(text).slice(0, limit).join('');

  const characters = Array.from(text);
  const beforeLength = Array.from(text.slice(0, index)).length;
  const sentenceLength = Array.from(normalizedSentence).length;
  const surroundingLength = Math.max(0, limit - sentenceLength);
  const start = Math.max(0, beforeLength - Math.floor(surroundingLength / 2));
  const end = Math.min(characters.length, start + limit);
  return characters.slice(Math.max(0, end - limit), end).join('');
}

function normalizeSource(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .trim();
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
      userId,
      normalizedSentence,
      normalizedParagraph,
      TRANSLATION_MODEL,
      TRANSLATION_RULES_VERSION
    ]))
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function lookupPage(request, total) {
  const url = new URL(request.url);
  const cursorValue = url.searchParams.get('cursor');
  const limitValue = url.searchParams.get('limit');

  // Existing readers do not paginate this endpoint. Preserve that contract while
  // doing the expensive work internally in bounded batches.
  if (cursorValue === null && limitValue === null) {
    return { cursor: 0, limit: total };
  }

  const parsedCursor = Number.parseInt(cursorValue || '0', 10);
  const parsedLimit = Number.parseInt(limitValue || String(MAX_EXPLICIT_LOOKUP_LIMIT), 10);
  const cursor = Number.isInteger(parsedCursor)
    ? Math.min(Math.max(parsedCursor, 0), total)
    : 0;
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_EXPLICIT_LOOKUP_LIMIT)
    : MAX_EXPLICIT_LOOKUP_LIMIT;
  return { cursor, limit };
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
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
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
    {
      error: 'This sentence is too long to translate in one request.',
      code: 'TRANSLATION_TOO_LONG'
    },
    { status: 413 }
  );
}

function sourceChanged() {
  return jsonResponse(
    { error: 'article changed during translation', code: 'TRANSLATION_SOURCE_CHANGED' },
    { status: 409 }
  );
}

function cacheUnavailable() {
  return jsonResponse({
    error: 'sentence translation cache is temporarily unavailable',
    code: 'TRANSLATION_CACHE_UNAVAILABLE',
    retryable: true
  }, { status: 503 });
}

function articleNotFound() {
  return jsonResponse(
    { error: 'article not found', code: 'ARTICLE_NOT_FOUND' },
    { status: 404 }
  );
}

function notFound() {
  return jsonResponse(
    { error: 'not found', code: 'NOT_FOUND' },
    { status: 404 }
  );
}
