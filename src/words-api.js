import { jsonResponse } from './http.js';
import { normalizeTerm } from '../public/lib/text.js';

export async function handleWordsApi(request, env, path, userId) {
  if (path === '/api/words' && request.method === 'GET') {
    return listWords(request, env.DB, userId);
  }
  if (path === '/api/words' && request.method === 'POST') {
    return createWord(request, env.DB, userId);
  }

  const match = path.match(/^\/api\/words\/([a-zA-Z0-9-]+)$/);
  if (!match) return jsonResponse({ error: 'not found' }, { status: 404 });
  if (request.method === 'GET') return getWord(env.DB, match[1], userId);
  if (request.method === 'PATCH') return updateWord(request, env.DB, match[1], userId);
  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'DELETE FROM words WHERE id = ? AND user_id = ?'
    ).bind(match[1], userId).run();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: 'not found' }, { status: 404 });
}

async function listWords(request, DB, userId) {
  const params = new URL(request.url).searchParams;
  const page = positiveInt(params.get('page'), 1);
  const pageSize = Math.min(100, positiveInt(params.get('pageSize'), 24));
  const where = ['w.user_id = ?'];
  const bindings = [userId];
  const keyword = normalizeTerm(params.get('keyword') || '');
  if (keyword) {
    where.push('(lower(w.lemma) LIKE ? OR lower(w.zh) LIKE ?)');
    bindings.push(`%${keyword}%`, `%${keyword}%`);
  }
  const tag = params.get('tag');
  if (tag) {
    where.push(`EXISTS (
      SELECT 1 FROM word_tags wt
      JOIN tags t ON t.id = wt.tag_id
      WHERE wt.word_id = w.id AND t.user_id = w.user_id AND t.id = ?
    )`);
    bindings.push(tag);
  }
  const state = params.get('state');
  if (state != null && state !== '') {
    const parsed = Number.parseInt(state, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
      return jsonResponse(
        { error: 'invalid state', code: 'INVALID_WORD_FILTER' },
        { status: 400 }
      );
    }
    where.push('r.state = ?');
    bindings.push(parsed);
  }
  if (params.get('due') === '1') {
    where.push('r.due_at <= ?');
    bindings.push(Date.now());
  }
  const whereSql = where.join(' AND ');
  const count = await DB.prepare(`
    SELECT COUNT(*) AS total
    FROM words w
    JOIN word_review_state r ON r.word_id = w.id AND r.user_id = w.user_id
    WHERE ${whereSql}
  `).bind(...bindings).first();
  const sort = {
    word: 'w.lemma COLLATE NOCASE, w.created_at DESC',
    due: 'r.due_at, w.created_at',
    created: 'w.created_at DESC'
  }[params.get('sort')] || 'r.due_at, w.created_at DESC';
  const { results: words } = await DB.prepare(`
    SELECT
      w.id, w.en, w.lemma, w.zh, w.example, w.stress, w.created_at,
      r.due_at, r.state, r.reps, r.lapses, r.scheduled_days, r.last_review_at
    FROM words w
    JOIN word_review_state r ON r.word_id = w.id AND r.user_id = w.user_id
    WHERE ${whereSql}
    ORDER BY ${sort}
    LIMIT ? OFFSET ?
  `).bind(...bindings, pageSize, (page - 1) * pageSize).all();
  const [forms, tags] = await Promise.all([
    loadForms(DB, userId),
    loadTags(DB, userId)
  ]);
  return jsonResponse({
    words: words.map(word => presentWord(word, forms, tags)),
    total: Number(count?.total || 0),
    page,
    pageSize
  });
}

async function createWord(request, DB, userId) {
  const body = await parseBody(request);
  const input = normalizedInput(body);
  if (!input) return invalidWord();
  const tagIds = validTagIds(body?.tagIds);
  if (!tagIds || !(await ownsTags(DB, userId, tagIds))) {
    return jsonResponse({ error: 'invalid tags', code: 'INVALID_TAGS' }, { status: 400 });
  }
  const id = crypto.randomUUID();
  const formId = crypto.randomUUID();
  const createdAt = Date.now();
  await DB.batch([
    DB.prepare(`
      INSERT INTO words
        (id, user_id, en, lemma, zh, example, stress, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, userId, input.lemma, input.lemma, input.zh,
      input.example, input.stress, createdAt
    ),
    DB.prepare(`
      INSERT INTO word_forms
        (id, word_id, user_id, form, normalized_form, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(formId, id, userId, input.form, normalizeTerm(input.form), createdAt),
    DB.prepare(`
      INSERT INTO word_review_state
        (word_id, user_id, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, userId, createdAt, createdAt, createdAt),
    ...tagIds.map(tagId => DB.prepare(`
      INSERT INTO word_tags (word_id, tag_id, created_at) VALUES (?, ?, ?)
    `).bind(id, tagId, createdAt))
  ]);
  const tags = await tagsByIds(DB, userId, tagIds);
  return jsonResponse({
    id,
    en: input.lemma,
    lemma: input.lemma,
    zh: input.zh,
    example: input.example,
    stress: input.stress,
    created_at: createdAt,
    due_at: createdAt,
    state: 0,
    reps: 0,
    lapses: 0,
    scheduled_days: 0,
    last_review_at: null,
    forms: [{ form: input.form, normalized_form: normalizeTerm(input.form) }],
    tags
  }, { status: 201 });
}

async function getWord(DB, wordId, userId) {
  const row = await DB.prepare(`
    SELECT
      w.id, w.en, w.lemma, w.zh, w.example, w.stress, w.created_at,
      r.due_at, r.state, r.reps, r.lapses, r.scheduled_days, r.last_review_at
    FROM words w
    JOIN word_review_state r ON r.word_id = w.id AND r.user_id = w.user_id
    WHERE w.id = ? AND w.user_id = ?
  `).bind(wordId, userId).first();
  if (!row) {
    return jsonResponse(
      { error: 'not found', code: 'WORD_NOT_FOUND' },
      { status: 404 }
    );
  }
  const [forms, tags] = await Promise.all([
    loadForms(DB, userId),
    loadTags(DB, userId)
  ]);
  return jsonResponse({ word: presentWord(row, forms, tags) });
}

async function updateWord(request, DB, wordId, userId) {
  const body = await parseBody(request);
  const input = normalizedInput(body, true);
  if (!input) return invalidWord();
  const replacesTags = Object.prototype.hasOwnProperty.call(body, 'tagIds');
  const tagIds = replacesTags ? validTagIds(body.tagIds) : [];
  if (replacesTags && (!tagIds || !(await ownsTags(DB, userId, tagIds)))) {
    return jsonResponse({ error: 'invalid tags', code: 'INVALID_TAGS' }, { status: 400 });
  }
  const existing = await DB.prepare(
    'SELECT id FROM words WHERE id = ? AND user_id = ?'
  ).bind(wordId, userId).first();
  if (!existing) {
    return jsonResponse(
      { error: 'not found', code: 'WORD_NOT_FOUND' },
      { status: 404 }
    );
  }
  const statements = [
    DB.prepare(`
      UPDATE words SET en = ?, lemma = ?, zh = ?, example = ?, stress = ?
      WHERE id = ? AND user_id = ?
    `).bind(
      input.lemma, input.lemma, input.zh, input.example,
      input.stress, wordId, userId
    )
  ];
  if (replacesTags) {
    statements.push(
      DB.prepare('DELETE FROM word_tags WHERE word_id = ?').bind(wordId),
      ...tagIds.map(tagId => DB.prepare(`
      INSERT INTO word_tags (word_id, tag_id, created_at) VALUES (?, ?, ?)
    `).bind(wordId, tagId, Date.now()))
    );
  }
  await DB.batch(statements);
  const tags = replacesTags
    ? await tagsByIds(DB, userId, tagIds)
    : (await loadTags(DB, userId)).get(wordId) || [];
  return jsonResponse({
    id: wordId,
    en: input.lemma,
    lemma: input.lemma,
    zh: input.zh,
    example: input.example,
    stress: input.stress,
    tags
  });
}

function presentWord(word, forms, tags) {
  return {
    ...word,
    lemma: word.lemma || word.en,
    forms: forms.get(word.id) || [],
    tags: tags.get(word.id) || []
  };
}

async function loadForms(DB, userId) {
  const { results } = await DB.prepare(`
    SELECT word_id, form, normalized_form
    FROM word_forms WHERE user_id = ? ORDER BY created_at
  `).bind(userId).all();
  const map = new Map();
  for (const row of results) {
    const list = map.get(row.word_id) || [];
    list.push({ form: row.form, normalized_form: row.normalized_form });
    map.set(row.word_id, list);
  }
  return map;
}

async function loadTags(DB, userId) {
  const { results } = await DB.prepare(`
    SELECT wt.word_id, t.id, t.name
    FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
    WHERE t.user_id = ? ORDER BY t.name
  `).bind(userId).all();
  const map = new Map();
  for (const row of results) {
    const list = map.get(row.word_id) || [];
    list.push({ id: row.id, name: row.name });
    map.set(row.word_id, list);
  }
  return map;
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

async function tagsByIds(DB, userId, tagIds) {
  if (!tagIds.length) return [];
  const placeholders = tagIds.map(() => '?').join(',');
  const { results } = await DB.prepare(`
    SELECT id, name FROM tags
    WHERE user_id = ? AND id IN (${placeholders})
    ORDER BY name
  `).bind(userId, ...tagIds).all();
  return results;
}

function validTagIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) return null;
  return [...new Set(value)];
}

function normalizedInput(body, editing = false) {
  if (
    !body ||
    typeof (body.lemma ?? body.en) !== 'string' ||
    typeof body.zh !== 'string' ||
    (editing && typeof body.example !== 'string') ||
    (editing && typeof body.stress !== 'string')
  ) return null;
  const form = String(body.en ?? body.lemma).trim();
  const lemma = normalizeTerm(body.lemma || body.en);
  const zh = body.zh.trim();
  if (!form || !lemma || !zh) return null;
  return {
    form,
    lemma,
    zh,
    example: typeof body.example === 'string' ? body.example : '',
    stress: typeof body.stress === 'string' ? body.stress.trim() : ''
  };
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value || '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

async function parseBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function invalidWord() {
  return jsonResponse(
    { error: 'lemma and zh are required', code: 'WORD_REQUIRED_FIELDS' },
    { status: 400 }
  );
}
