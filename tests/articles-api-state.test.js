import test from 'node:test';
import assert from 'node:assert/strict';
import { handleArticlesApi } from '../src/articles-api.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('PATCH removes absent sources while preserving a pending term shared by another article', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'Old body');
  insertArticle(DB, 'a2', 'Shared source');
  insertPending(DB, 't-orphan', 'orphan');
  insertPending(DB, 't-shared', 'shared');
  insertMarking(DB, 'm-orphan', 'a1', 'orphan', 't-orphan');
  insertMarking(DB, 'm-shared-a1', 'a1', 'shared', 't-shared');
  insertMarking(DB, 'm-shared-a2', 'a2', 'shared', 't-shared');
  DB.prepare(`
    UPDATE article_progress
    SET last_aloud_sentence_index = 2, last_aloud_offset_seconds = 2.75
    WHERE article_id = 'a1'
  `).run();

  const response = await handleArticlesApi(jsonRequest('PATCH', {
    title: 'Edited', body: 'No tracked vocabulary remains.'
  }), { DB }, '/api/articles/a1', 'u1');

  assert.equal(response.status, 200);
  assert.deepEqual(DB.all(
    'SELECT id FROM article_markings WHERE article_id = ? ORDER BY id', 'a1'
  ), []);
  assert.deepEqual(DB.all(
    'SELECT id FROM marked_terms WHERE user_id = ? ORDER BY id', 'u1'
  ).map(row => row.id), ['t-shared']);
  assert.deepEqual(DB.all(
    'SELECT id FROM article_markings WHERE marked_term_id = ?', 't-shared'
  ).map(row => row.id), ['m-shared-a2']);
  assert.deepEqual(DB.get(`
    SELECT last_aloud_sentence_index, last_aloud_offset_seconds
    FROM article_progress WHERE article_id = 'a1'
  `), {
    last_aloud_sentence_index: null,
    last_aloud_offset_seconds: 0
  });
});

test('DELETE removes an orphan pending term but preserves a shared pending term', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'First article');
  insertArticle(DB, 'a2', 'Second article');
  insertPending(DB, 't-orphan', 'orphan');
  insertPending(DB, 't-shared', 'shared');
  insertMarking(DB, 'm-orphan', 'a1', 'orphan', 't-orphan');
  insertMarking(DB, 'm-shared-a1', 'a1', 'shared', 't-shared');
  insertMarking(DB, 'm-shared-a2', 'a2', 'shared', 't-shared');

  const response = await handleArticlesApi(
    new Request('https://app/api/articles/a1', { method: 'DELETE' }),
    { DB }, '/api/articles/a1', 'u1'
  );

  assert.equal(response.status, 200);
  assert.equal(DB.get('SELECT id FROM articles WHERE id = ?', 'a1'), null);
  assert.equal(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't-orphan'), null);
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't-shared'), {
    id: 't-shared'
  });
  assert.deepEqual(DB.all(
    'SELECT id FROM article_markings WHERE marked_term_id = ?', 't-shared'
  ).map(row => row.id), ['m-shared-a2']);
});

test('resetProgress zeroes every aggregate and removes progress events', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'Body');
  DB.prepare(`
    UPDATE article_progress
    SET last_position_ratio = ?, completed = ?, read_count = ?, active_read_ms = ?,
        full_read_aloud_count = ?, last_aloud_sentence_index = ?,
        last_aloud_offset_seconds = ?
    WHERE article_id = ?
  `).bind(0.75, 1, 4, 5000, 3, 2, 2.75, 'a1').run();
  DB.prepare(`
    INSERT INTO article_progress_events
      (id, article_id, user_id, event_type, amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind('e1', 'a1', 'u1', 'active_ms', 5000, 10).run();

  const response = await handleArticlesApi(jsonRequest('PATCH', {
    title: 'Same', body: 'Body', resetProgress: true
  }), { DB }, '/api/articles/a1', 'u1');

  assert.equal(response.status, 200);
  assert.deepEqual(DB.get(`
    SELECT last_position_ratio, completed, read_count, active_read_ms,
           full_read_aloud_count, last_aloud_sentence_index, last_aloud_offset_seconds
    FROM article_progress WHERE article_id = ?
  `, 'a1'), {
    last_position_ratio: 0,
    completed: 0,
    read_count: 0,
    active_read_ms: 0,
    full_read_aloud_count: 0,
    last_aloud_sentence_index: null,
    last_aloud_offset_seconds: 0
  });
  assert.equal(DB.get(
    'SELECT count(*) AS count FROM article_progress_events WHERE article_id = ?', 'a1'
  ).count, 0);
});

test('metadata-only changes preserve the aloud sentence in real storage', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'Body');
  DB.prepare(`
    UPDATE article_progress
    SET last_aloud_sentence_index = 2, last_aloud_offset_seconds = 2.75
    WHERE article_id = 'a1'
  `).run();

  const response = await handleArticlesApi(jsonRequest('PATCH', {
    title: 'Renamed', author: 'Writer'
  }), { DB }, '/api/articles/a1', 'u1');

  assert.equal(response.status, 200);
  assert.deepEqual(DB.get(`
    SELECT last_aloud_sentence_index, last_aloud_offset_seconds
    FROM article_progress WHERE article_id = 'a1'
  `), {
    last_aloud_sentence_index: 2,
    last_aloud_offset_seconds: 2.75
  });
});

function createSeededDb() {
  const DB = createSqliteDb();
  DB.prepare(`
    INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, NULL, ?)
  `).bind('u1', 'user-one', 1).run();
  return DB;
}

function insertArticle(DB, id, body) {
  DB.prepare(`
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', '', '', ?, ?)
  `).bind(id, 'u1', id, body, 1, 1).run();
  DB.prepare(`
    INSERT INTO article_progress
      (article_id, user_id, last_position_ratio, completed, read_count,
       active_read_ms, full_read_aloud_count, updated_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, ?)
  `).bind(id, 'u1', 1).run();
}

function insertPending(DB, id, normalizedText) {
  DB.prepare(`
    INSERT INTO marked_terms
      (id, user_id, display_text, normalized_text, kind, created_at)
    VALUES (?, ?, ?, ?, 'word', ?)
  `).bind(id, 'u1', normalizedText, normalizedText, 1).run();
}

function insertMarking(DB, id, articleId, normalizedText, pendingId) {
  DB.prepare(`
    INSERT INTO article_markings
      (id, article_id, user_id, normalized_text, selected_text,
       context_sentence, marked_term_id, word_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).bind(
    id, articleId, 'u1', normalizedText, normalizedText,
    `${normalizedText} context`, pendingId, 1
  ).run();
}

function jsonRequest(method, body) {
  return new Request('https://app/api/articles/a1', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
