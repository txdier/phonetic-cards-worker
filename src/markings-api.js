import { jsonResponse } from './http.js';
import { containsNormalizedTerm, normalizeTerm } from '../public/lib/text.js';

const JS_TRIM_CHARACTERS =
  ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006' +
  '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export async function handleMarkingsApi(request, env, path, userId) {
  if (path === '/api/marked-terms' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT
        t.id, t.display_text, t.normalized_text, t.kind, t.created_at,
        COUNT(m.id) AS source_count,
        (
          SELECT latest.context_sentence
          FROM article_markings latest
          WHERE latest.marked_term_id = t.id AND latest.user_id = t.user_id
          ORDER BY latest.created_at DESC, latest.id DESC
          LIMIT 1
        ) AS context_sentence
      FROM marked_terms t
      LEFT JOIN article_markings m
        ON m.marked_term_id = t.id AND m.user_id = t.user_id
      WHERE t.user_id = ?
      GROUP BY t.id, t.display_text, t.normalized_text, t.kind, t.created_at
      ORDER BY t.created_at DESC
    `).bind(userId).all();
    return jsonResponse(results);
  }

  const createMatch = path.match(/^\/api\/articles\/([a-zA-Z0-9-]+)\/markings$/);
  if (createMatch && request.method === 'POST') {
    return createMarking(request, env, createMatch[1], userId);
  }

  const localDeleteMatch = path.match(
    /^\/api\/articles\/([a-zA-Z0-9-]+)\/markings\/([a-zA-Z0-9-]+)$/
  );
  if (localDeleteMatch && request.method === 'DELETE') {
    return deleteArticleMarking(env, localDeleteMatch[1], localDeleteMatch[2], userId);
  }

  const conversionMatch = path.match(
    /^\/api\/marked-terms\/([a-zA-Z0-9-]+)\/add-to-word$/
  );
  if (conversionMatch && request.method === 'POST') {
    return convertMarkedTerm(request, env, conversionMatch[1], userId);
  }

  const globalDeleteMatch = path.match(/^\/api\/marked-terms\/([a-zA-Z0-9-]+)$/);
  if (globalDeleteMatch && request.method === 'DELETE') {
    return deleteMarkedTerm(env, globalDeleteMatch[1], userId);
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}

export function appendMeaning(existingValue, newValue) {
  const existing = splitMeanings(existingValue);
  for (const addition of uniqueMeanings(newValue)) {
    if (!existing.includes(addition)) existing.push(addition);
  }
  return existing.join('；');
}

async function createMarking(request, env, articleId, userId) {
  const body = await parseObjectBody(request);
  if (!body) return invalidBody();
  if (
    typeof body.selectedText !== 'string' ||
    !optionalString(body, 'normalizedText') ||
    !optionalString(body, 'contextSentence')
  ) return invalidBody();

  const article = await env.DB.prepare(`
    SELECT id, body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
  if (!article) return notFound('ARTICLE_NOT_FOUND');

  const selectedText = body.selectedText.trim();
  const normalizedText = normalizeTerm(selectedText);
  if (!normalizedText) return invalidBody();
  if (!containsNormalizedTerm(article.body, normalizedText)) {
    return jsonResponse(
      { error: 'term does not occur in article', code: 'TERM_NOT_IN_ARTICLE' },
      { status: 400 }
    );
  }

  const duplicate = await env.DB.prepare(`
    SELECT id, article_id, normalized_text, selected_text, context_sentence,
           marked_term_id, word_id, created_at
    FROM article_markings
    WHERE article_id = ? AND normalized_text = ? AND user_id = ?
  `).bind(articleId, normalizedText, userId).first();
  if (duplicate) return jsonResponse(duplicate);

  const pendingId = crypto.randomUUID();
  const markingId = crypto.randomUUID();
  const createdAt = Date.now();
  const contextSentence = (body.contextSentence || '').trim();
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO marked_terms
        (id, user_id, display_text, normalized_text, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      pendingId, userId, selectedText, normalizedText,
      /\s/.test(normalizedText) ? 'phrase' : 'word', createdAt
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO article_markings
      (id, article_id, user_id, normalized_text, selected_text,
       context_sentence, marked_term_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, id, ?
      FROM marked_terms
      WHERE normalized_text = ? AND user_id = ?
  `).bind(
    markingId, articleId, userId, normalizedText, selectedText,
    contextSentence, createdAt, normalizedText, userId
    ),
    env.DB.prepare(`
      SELECT id, article_id, normalized_text, selected_text, context_sentence,
             marked_term_id, word_id, created_at
      FROM article_markings
      WHERE article_id = ? AND normalized_text = ? AND user_id = ?
    `).bind(articleId, normalizedText, userId)
  ]);
  return jsonResponse(results[2].results[0], {
    status: results[1].meta.changes ? 201 : 200
  });
}

async function deleteArticleMarking(env, articleId, markingId, userId) {
  const marking = await env.DB.prepare(`
    SELECT m.id, m.marked_term_id
    FROM article_markings m
    JOIN articles a ON a.id = m.article_id AND a.user_id = m.user_id
    WHERE m.id = ? AND m.article_id = ? AND m.user_id = ?
  `).bind(markingId, articleId, userId).first();
  if (!marking) return notFound('MARKING_NOT_FOUND');

  const statements = [env.DB.prepare(`
    DELETE FROM article_markings
    WHERE id = ? AND article_id = ? AND user_id = ?
  `).bind(markingId, articleId, userId)];
  if (marking.marked_term_id) {
    statements.push(env.DB.prepare(`
      DELETE FROM marked_terms
      WHERE id = ? AND user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM article_markings
          WHERE marked_term_id = ? AND user_id = ?
        )
    `).bind(marking.marked_term_id, userId, marking.marked_term_id, userId));
  }
  await env.DB.batch(statements);
  return jsonResponse({ ok: true });
}

async function deleteMarkedTerm(env, termId, userId) {
  const pending = await env.DB.prepare(`
    SELECT id FROM marked_terms WHERE id = ? AND user_id = ?
  `).bind(termId, userId).first();
  if (!pending) return notFound('MARKED_TERM_NOT_FOUND');

  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM article_markings WHERE marked_term_id = ? AND user_id = ?
    `).bind(termId, userId),
    env.DB.prepare(`
      DELETE FROM marked_terms WHERE id = ? AND user_id = ?
    `).bind(termId, userId)
  ]);
  return jsonResponse({ ok: true });
}

async function convertMarkedTerm(request, env, termId, userId) {
  const body = await parseObjectBody(request);
  if (!body) return invalidBody();
  if (
    typeof body.zh !== 'string' ||
    !optionalString(body, 'lemma') ||
    !optionalString(body, 'strategy') ||
    !optionalString(body, 'targetWordId') ||
    !optionalString(body, 'example') ||
    !optionalString(body, 'stress') ||
    !optionalStringArray(body, 'tagIds')
  ) return invalidBody();
  if (
    Object.prototype.hasOwnProperty.call(body, 'strategy') &&
    body.strategy !== 'merge' && body.strategy !== 'new'
  ) return invalidBody();

  const pending = await env.DB.prepare(`
    SELECT id, display_text, normalized_text
    FROM marked_terms WHERE id = ? AND user_id = ?
  `).bind(termId, userId).first();
  if (!pending) return notFound('MARKED_TERM_NOT_FOUND');

  const zh = uniqueMeanings(body.zh).join('；');
  const lemma = normalizeTerm(body.lemma || pending.normalized_text);
  if (!zh || !lemma) return invalidBody();
  const tagIds = [...new Set(body.tagIds || [])];
  if (!(await ownsTags(env.DB, userId, tagIds))) return notFound('TAG_NOT_FOUND');

  const { results: matches } = await env.DB.prepare(`
    SELECT id, en, lemma, zh, example, stress, created_at
    FROM words WHERE lemma = ? AND user_id = ? ORDER BY created_at DESC
  `).bind(lemma, userId).all();
  if (!body.strategy && matches.length) {
    return jsonResponse({
      error: 'a card with this lemma already exists',
      code: 'LEMMA_EXISTS',
      matches
    }, { status: 409 });
  }

  if (body.strategy === 'merge') {
    if (!body.targetWordId.trim()) return invalidBody();
    return mergeIntoWord(env, pending, body, lemma, zh, userId, tagIds);
  }
  return createWord(env, pending, body, lemma, zh, userId, tagIds);
}

async function mergeIntoWord(env, pending, body, lemma, zh, userId, tagIds) {
  const targetWordId = body.targetWordId.trim();
  const target = await env.DB.prepare(`
    SELECT id, en, lemma, zh, example, stress, created_at
    FROM words WHERE id = ? AND lemma = ? AND user_id = ?
  `).bind(targetWordId, lemma, userId).first();
  if (!target) return notFound('WORD_NOT_FOUND');

  const formId = crypto.randomUUID();
  const createdAt = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE words AS target
      SET zh = (
        WITH RECURSIVE existing_meanings(position, rest, meaning) AS (
            SELECT 0, target.zh || '；', ''
            UNION ALL
            SELECT
              position + 1,
              substr(rest, instr(rest, '；') + 1),
              trim(substr(rest, 1, instr(rest, '；') - 1), ?)
            FROM existing_meanings
            WHERE rest <> ''
        ),
        existing_cleaned AS (
          SELECT position, meaning FROM existing_meanings WHERE meaning <> ''
        ),
        incoming_meanings(position, rest, meaning) AS (
          SELECT 0, ? || '；', ''
          UNION ALL
          SELECT
            position + 1,
            substr(rest, instr(rest, '；') + 1),
            trim(substr(rest, 1, instr(rest, '；') - 1), ?)
          FROM incoming_meanings
          WHERE rest <> ''
        ),
        incoming_cleaned AS (
          SELECT MIN(position) AS position, meaning
          FROM incoming_meanings
          WHERE meaning <> ''
          GROUP BY meaning
        ),
        combined AS (
          SELECT 0 AS source, position, meaning FROM existing_cleaned
          UNION ALL
          SELECT 1, incoming.position, incoming.meaning
          FROM incoming_cleaned AS incoming
          WHERE NOT EXISTS (
            SELECT 1 FROM existing_cleaned
            WHERE existing_cleaned.meaning = incoming.meaning
          )
        ),
        normalized AS (
          SELECT COALESCE(group_concat(meaning, '；'), '') AS value
          FROM (
            SELECT meaning FROM combined ORDER BY source, position
          )
        )
        SELECT value FROM normalized
      )
      WHERE id = ? AND lemma = ? AND user_id = ?
        AND EXISTS (
          SELECT 1 FROM marked_terms WHERE id = ? AND user_id = ?
        )
    `).bind(
      JS_TRIM_CHARACTERS, zh, JS_TRIM_CHARACTERS,
      target.id, lemma, userId, pending.id, userId
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO word_forms
        (id, word_id, user_id, form, normalized_form, created_at)
      SELECT ?, ?, ?, display_text, normalized_text, ?
      FROM marked_terms WHERE id = ? AND user_id = ?
    `).bind(
      formId, target.id, userId, createdAt, pending.id, userId
    ),
    ...tagIds.map(tagId => env.DB.prepare(`
      INSERT OR IGNORE INTO word_tags (word_id, tag_id, created_at)
      VALUES (?, ?, ?)
    `).bind(target.id, tagId, createdAt)),
    env.DB.prepare(`
      UPDATE article_markings
      SET marked_term_id = NULL, word_id = ?
      WHERE marked_term_id = ? AND user_id = ?
    `).bind(target.id, pending.id, userId),
    env.DB.prepare(`
      DELETE FROM marked_terms WHERE id = ? AND user_id = ?
    `).bind(pending.id, userId),
    env.DB.prepare(`
      SELECT id, en, lemma, zh, example, stress, created_at
      FROM words WHERE id = ? AND lemma = ? AND user_id = ?
    `).bind(target.id, lemma, userId)
  ]);
  if (!results.at(-2).meta.changes) return alreadyConverted();
  return jsonResponse(results.at(-1).results[0]);
}

async function createWord(env, pending, body, lemma, zh, userId, tagIds) {
  const wordId = crypto.randomUUID();
  const formId = crypto.randomUUID();
  const createdAt = Date.now();
  const example = body.example || '';
  const stress = body.stress || '';
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO words
        (id, user_id, en, lemma, zh, example, stress, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      FROM marked_terms WHERE id = ? AND user_id = ?
    `).bind(
      wordId, userId, lemma, lemma, zh, example, stress, createdAt,
      pending.id, userId
    ),
    env.DB.prepare(`
      INSERT INTO word_forms
        (id, word_id, user_id, form, normalized_form, created_at)
      SELECT ?, ?, ?, display_text, normalized_text, ?
      FROM marked_terms WHERE id = ? AND user_id = ?
    `).bind(
      formId, wordId, userId, createdAt, pending.id, userId
    ),
    env.DB.prepare(`
      INSERT INTO word_review_state
        (word_id, user_id, due_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM marked_terms WHERE id = ? AND user_id = ?
      )
    `).bind(
      wordId, userId, createdAt, createdAt, createdAt, pending.id, userId
    ),
    ...tagIds.map(tagId => env.DB.prepare(`
      INSERT INTO word_tags (word_id, tag_id, created_at)
      VALUES (?, ?, ?)
    `).bind(wordId, tagId, createdAt)),
    env.DB.prepare(`
      UPDATE article_markings
      SET marked_term_id = NULL, word_id = ?
      WHERE marked_term_id = ? AND user_id = ?
    `).bind(wordId, pending.id, userId),
    env.DB.prepare(`
      DELETE FROM marked_terms WHERE id = ? AND user_id = ?
    `).bind(pending.id, userId)
  ]);
  if (!results.at(-1).meta.changes) return alreadyConverted();
  return jsonResponse({
    id: wordId,
    en: lemma,
    lemma,
    zh,
    example,
    stress,
    created_at: createdAt,
    due_at: createdAt,
    state: 0,
    reps: 0,
    lapses: 0,
    forms: [{ form: pending.display_text, normalized_form: pending.normalized_text }]
  }, { status: 201 });
}

async function parseObjectBody(request) {
  try {
    const body = await request.json();
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(body, name) {
  return !Object.prototype.hasOwnProperty.call(body, name) || typeof body[name] === 'string';
}

function optionalStringArray(body, name) {
  return !Object.prototype.hasOwnProperty.call(body, name)
    || (Array.isArray(body[name]) && body[name].every(value => typeof value === 'string'));
}

async function ownsTags(DB, userId, tagIds) {
  if (!tagIds.length) return true;
  const placeholders = tagIds.map(() => '?').join(',');
  const row = await DB.prepare(`
    SELECT COUNT(*) AS count FROM tags
    WHERE user_id = ? AND id IN (${placeholders})
  `).bind(userId, ...tagIds).first();
  return Number(row?.count) === tagIds.length;
}

function splitMeanings(value) {
  return String(value || '').split('；').map(item => item.trim()).filter(Boolean);
}

function uniqueMeanings(value) {
  return [...new Set(splitMeanings(value))];
}

function invalidBody() {
  return jsonResponse(
    { error: 'request body is invalid', code: 'INVALID_BODY' },
    { status: 400 }
  );
}

function notFound(code) {
  return jsonResponse({ error: 'not found', code }, { status: 404 });
}

function alreadyConverted() {
  return jsonResponse(
    { error: 'marked term was already converted', code: 'MARKED_TERM_ALREADY_CONVERTED' },
    { status: 409 }
  );
}
