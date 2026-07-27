import { jsonResponse } from './http.js';

const RELATION_TYPES = new Set([
  'family', 'derivative', 'synonym', 'antonym', 'confusable', 'other'
]);

export async function handleWordLibraryApi(request, env, path, userId) {
  if (path === '/api/tags') {
    if (request.method === 'GET') return listTags(env.DB, userId);
    if (request.method === 'POST') return createTag(request, env.DB, userId);
  }

  const tagMatch = path.match(/^\/api\/tags\/([a-zA-Z0-9-]+)$/);
  if (tagMatch && request.method === 'PATCH') {
    return updateTag(request, env.DB, tagMatch[1], userId);
  }
  if (tagMatch && request.method === 'DELETE') {
    await env.DB.prepare(
      'DELETE FROM tags WHERE id = ? AND user_id = ?'
    ).bind(tagMatch[1], userId).run();
    return jsonResponse({ ok: true });
  }

  const wordTagsMatch = path.match(/^\/api\/words\/([a-zA-Z0-9-]+)\/tags$/);
  if (wordTagsMatch && request.method === 'PUT') {
    return replaceWordTags(request, env.DB, wordTagsMatch[1], userId);
  }

  const relationsMatch = path.match(/^\/api\/words\/([a-zA-Z0-9-]+)\/relations$/);
  if (relationsMatch && request.method === 'GET') {
    return listRelations(env.DB, relationsMatch[1], userId);
  }
  if (relationsMatch && request.method === 'POST') {
    return createRelation(request, env.DB, relationsMatch[1], userId);
  }

  const relationMatch = path.match(
    /^\/api\/words\/([a-zA-Z0-9-]+)\/relations\/([a-zA-Z0-9-]+)$/
  );
  if (relationMatch && request.method === 'PATCH') {
    return updateRelation(request, env.DB, relationMatch[1], relationMatch[2], userId);
  }
  if (relationMatch && request.method === 'DELETE') {
    await env.DB.prepare(`
      DELETE FROM word_relations
      WHERE id = ? AND user_id = ? AND (word_id_a = ? OR word_id_b = ?)
    `).bind(relationMatch[2], userId, relationMatch[1], relationMatch[1]).run();
    return jsonResponse({ ok: true });
  }

  if (path === '/api/word-stats' && request.method === 'GET') {
    return wordStats(env.DB, userId);
  }
  if (path === '/api/export' && request.method === 'GET') {
    return exportWords(request, env.DB, userId);
  }
  return jsonResponse({ error: 'not found' }, { status: 404 });
}

async function listTags(DB, userId) {
  const { results } = await DB.prepare(`
    SELECT t.id, t.name, COUNT(wt.word_id) AS word_count
    FROM tags t
    LEFT JOIN word_tags wt ON wt.tag_id = t.id
    WHERE t.user_id = ?
    GROUP BY t.id, t.name
    ORDER BY t.normalized_name
  `).bind(userId).all();
  return jsonResponse({ tags: results });
}

async function createTag(request, DB, userId) {
  const body = await parseBody(request);
  const name = cleanName(body?.name);
  if (!name) return invalid('INVALID_TAG');
  const normalized = name.toLowerCase();
  const existing = await DB.prepare(`
    SELECT id, name FROM tags WHERE user_id = ? AND normalized_name = ?
  `).bind(userId, normalized).first();
  if (existing) return jsonResponse({ tag: existing });
  const tag = { id: crypto.randomUUID(), name };
  await DB.prepare(`
    INSERT INTO tags (id, user_id, name, normalized_name, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tag.id, userId, name, normalized, Date.now()).run();
  return jsonResponse({ tag }, { status: 201 });
}

async function updateTag(request, DB, tagId, userId) {
  const body = await parseBody(request);
  const name = cleanName(body?.name);
  if (!name) return invalid('INVALID_TAG');
  const result = await DB.prepare(`
    UPDATE tags SET name = ?, normalized_name = ?
    WHERE id = ? AND user_id = ?
  `).bind(name, name.toLowerCase(), tagId, userId).run();
  if (!result.meta.changes) return notFound('TAG_NOT_FOUND');
  return jsonResponse({ tag: { id: tagId, name } });
}

async function replaceWordTags(request, DB, wordId, userId) {
  const body = await parseBody(request);
  if (!Array.isArray(body?.tagIds) || body.tagIds.some(id => typeof id !== 'string')) {
    return invalid('INVALID_TAGS');
  }
  const word = await DB.prepare(
    'SELECT id FROM words WHERE id = ? AND user_id = ?'
  ).bind(wordId, userId).first();
  if (!word) return notFound('WORD_NOT_FOUND');
  const tagIds = [...new Set(body.tagIds)];
  if (tagIds.length) {
    const placeholders = tagIds.map(() => '?').join(',');
    const owned = await DB.prepare(`
      SELECT id FROM tags WHERE user_id = ? AND id IN (${placeholders})
    `).bind(userId, ...tagIds).all();
    if (owned.results.length !== tagIds.length) return notFound('TAG_NOT_FOUND');
  }
  await DB.batch([
    DB.prepare('DELETE FROM word_tags WHERE word_id = ?').bind(wordId),
    ...tagIds.map(tagId => DB.prepare(`
      INSERT INTO word_tags (word_id, tag_id, created_at) VALUES (?, ?, ?)
    `).bind(wordId, tagId, Date.now()))
  ]);
  return jsonResponse({ ok: true, tagIds });
}

async function listRelations(DB, wordId, userId) {
  const word = await DB.prepare(
    'SELECT id FROM words WHERE id = ? AND user_id = ?'
  ).bind(wordId, userId).first();
  if (!word) return notFound('WORD_NOT_FOUND');
  const { results } = await DB.prepare(`
    SELECT
      r.id, r.relation_type, r.note, r.created_at, r.updated_at,
      CASE WHEN r.word_id_a = ? THEN b.id ELSE a.id END AS target_word_id,
      CASE WHEN r.word_id_a = ? THEN b.lemma ELSE a.lemma END AS target_lemma,
      CASE WHEN r.word_id_a = ? THEN b.zh ELSE a.zh END AS target_zh
    FROM word_relations r
    JOIN words a ON a.id = r.word_id_a AND a.user_id = r.user_id
    JOIN words b ON b.id = r.word_id_b AND b.user_id = r.user_id
    WHERE r.user_id = ? AND (r.word_id_a = ? OR r.word_id_b = ?)
    ORDER BY r.created_at
  `).bind(wordId, wordId, wordId, userId, wordId, wordId).all();
  return jsonResponse({ relations: results });
}

async function createRelation(request, DB, wordId, userId) {
  const body = await parseBody(request);
  if (
    !body ||
    typeof body.targetWordId !== 'string' ||
    body.targetWordId === wordId ||
    !RELATION_TYPES.has(body.relationType) ||
    (body.note != null && typeof body.note !== 'string')
  ) return invalid('INVALID_RELATION');

  const owned = await DB.prepare(`
    SELECT COUNT(*) AS count FROM words
    WHERE user_id = ? AND id IN (?, ?)
  `).bind(userId, wordId, body.targetWordId).first();
  if (Number(owned?.count) !== 2) return notFound('WORD_NOT_FOUND');
  const [wordA, wordB] = [wordId, body.targetWordId].sort();
  const exists = await DB.prepare(`
    SELECT id FROM word_relations
    WHERE user_id = ? AND word_id_a = ? AND word_id_b = ?
  `).bind(userId, wordA, wordB).first();
  if (exists) {
    return jsonResponse(
      { error: 'relation already exists', code: 'RELATION_EXISTS' },
      { status: 409 }
    );
  }
  const now = Date.now();
  const relation = {
    id: crypto.randomUUID(),
    targetWordId: body.targetWordId,
    relationType: body.relationType,
    note: (body.note || '').trim()
  };
  await DB.prepare(`
    INSERT INTO word_relations
      (id, user_id, word_id_a, word_id_b, relation_type, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    relation.id, userId, wordA, wordB, relation.relationType,
    relation.note, now, now
  ).run();
  return jsonResponse({ relation }, { status: 201 });
}

async function updateRelation(request, DB, wordId, relationId, userId) {
  const body = await parseBody(request);
  if (
    !body ||
    !RELATION_TYPES.has(body.relationType) ||
    (body.note != null && typeof body.note !== 'string')
  ) return invalid('INVALID_RELATION');
  const result = await DB.prepare(`
    UPDATE word_relations
    SET relation_type = ?, note = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND (word_id_a = ? OR word_id_b = ?)
  `).bind(
    body.relationType, (body.note || '').trim(), Date.now(),
    relationId, userId, wordId, wordId
  ).run();
  if (!result.meta.changes) return notFound('RELATION_NOT_FOUND');
  return jsonResponse({ ok: true });
}

async function wordStats(DB, userId) {
  const now = Date.now();
  const stats = await DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN r.due_at <= ? THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN r.state = 0 THEN 1 ELSE 0 END) AS new_count,
      SUM(CASE WHEN r.state IN (1, 3) THEN 1 ELSE 0 END) AS learning,
      SUM(CASE WHEN r.state = 2 THEN 1 ELSE 0 END) AS review
    FROM words w
    JOIN word_review_state r ON r.word_id = w.id AND r.user_id = w.user_id
    WHERE w.user_id = ?
  `).bind(now, userId).first();
  return jsonResponse({ stats: {
    total: Number(stats?.total || 0),
    due: Number(stats?.due || 0),
    new: Number(stats?.new_count || 0),
    learning: Number(stats?.learning || 0),
    review: Number(stats?.review || 0)
  } });
}

async function exportWords(request, DB, userId) {
  const format = new URL(request.url).searchParams.get('format') || 'markdown';
  if (!['markdown', 'csv', 'json'].includes(format)) return invalid('INVALID_EXPORT_FORMAT');
  const { results: words } = await DB.prepare(`
    SELECT w.id, w.lemma, w.zh, w.example, w.stress,
           r.state, r.due_at, r.reps, r.lapses
    FROM words w
    JOIN word_review_state r ON r.word_id = w.id AND r.user_id = w.user_id
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `).bind(userId).all();
  const { results: tagRows } = await DB.prepare(`
    SELECT wt.word_id, t.name
    FROM word_tags wt JOIN tags t ON t.id = wt.tag_id
    WHERE t.user_id = ? ORDER BY t.name
  `).bind(userId).all();
  const tags = new Map();
  for (const row of tagRows) {
    const list = tags.get(row.word_id) || [];
    list.push(row.name);
    tags.set(row.word_id, list);
  }
  const data = words.map(word => ({ ...word, tags: tags.get(word.id) || [] }));
  let body;
  let contentType;
  let extension;
  if (format === 'json') {
    body = JSON.stringify({ words: data }, null, 2);
    contentType = 'application/json; charset=utf-8';
    extension = 'json';
  } else if (format === 'csv') {
    const rows = [['word', 'meaning', 'example', 'stress', 'tags', 'state', 'due_at']];
    for (const word of data) {
      rows.push([
        word.lemma, word.zh, word.example, word.stress,
        word.tags.join('|'), word.state, word.due_at
      ]);
    }
    body = rows.map(row => row.map(csvCell).join(',')).join('\n');
    contentType = 'text/csv; charset=utf-8';
    extension = 'csv';
  } else {
    body = data.map(word => [
      `## ${word.lemma}`,
      '',
      word.zh,
      word.example ? `- 例句：${word.example}` : '',
      word.tags.length ? `- 标签：${word.tags.join('、')}` : '',
      ''
    ].filter(Boolean).join('\n')).join('\n\n');
    contentType = 'text/markdown; charset=utf-8';
    extension = 'md';
  }
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="phonetic-cards.${extension}"`
    }
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function cleanName(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 50)
    : '';
}

async function parseBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function invalid(code) {
  return jsonResponse({ error: 'invalid request', code }, { status: 400 });
}

function notFound(code) {
  return jsonResponse({ error: 'not found', code }, { status: 404 });
}
