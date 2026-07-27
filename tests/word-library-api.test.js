import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarkingsApi } from '../src/markings-api.js';
import { handleWordLibraryApi } from '../src/word-library-api.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('tags stay user scoped and can be attached to a word', async t => {
  const DB = seededDb();
  t.after(() => DB.close());

  const response = await handleWordLibraryApi(
    jsonRequest('/api/tags', 'POST', { name: '工作' }),
    { DB }, '/api/tags', 'u1'
  );
  const tag = (await response.json()).tag;
  await handleWordLibraryApi(
    jsonRequest('/api/words/w1/tags', 'PUT', { tagIds: [tag.id] }),
    { DB }, '/api/words/w1/tags', 'u1'
  );

  assert.deepEqual(DB.all(`
    SELECT t.name FROM tags t
    JOIN word_tags wt ON wt.tag_id = t.id
    WHERE wt.word_id = ?
  `, 'w1'), [{ name: '工作' }]);
  assert.equal(DB.get(
    'SELECT COUNT(*) AS count FROM tags WHERE user_id = ?', 'u2'
  ).count, 0);
});

test('relations reject cross-user targets and deduplicate an owned pair', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  insertWord(DB, 'w2', 'u1', 'deploy');
  insertWord(DB, 'w3', 'u2', 'private');

  const created = await handleWordLibraryApi(
    jsonRequest('/api/words/w1/relations', 'POST', {
      targetWordId: 'w2', relationType: 'confusable', note: '易混'
    }),
    { DB }, '/api/words/w1/relations', 'u1'
  );
  const duplicate = await handleWordLibraryApi(
    jsonRequest('/api/words/w1/relations', 'POST', {
      targetWordId: 'w2', relationType: 'synonym'
    }),
    { DB }, '/api/words/w1/relations', 'u1'
  );
  const foreign = await handleWordLibraryApi(
    jsonRequest('/api/words/w1/relations', 'POST', {
      targetWordId: 'w3', relationType: 'other'
    }),
    { DB }, '/api/words/w1/relations', 'u1'
  );

  assert.equal(created.status, 201);
  assert.equal(duplicate.status, 409);
  assert.equal(foreign.status, 404);
  assert.equal(DB.get(
    'SELECT COUNT(*) AS count FROM word_relations WHERE user_id = ?', 'u1'
  ).count, 1);
});

test('merging an article marking keeps existing tags and unions selected tags', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  DB.exec(`
    INSERT INTO tags (id, user_id, name, normalized_name, created_at)
    VALUES
      ('t-old', 'u1', '旧标签', '旧标签', 1),
      ('t-new', 'u1', '新标签', '新标签', 1);
    INSERT INTO word_tags (word_id, tag_id, created_at)
    VALUES ('w1', 't-old', 1);
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES ('a1', 'u1', 'One', 'Confirm it.', '', '', '', 1, 1);
    INSERT INTO marked_terms
      (id, user_id, display_text, normalized_text, kind, created_at)
    VALUES ('p1', 'u1', 'Confirm', 'confirm', 'word', 1);
    INSERT INTO article_markings
      (id, article_id, user_id, normalized_text, selected_text,
       context_sentence, marked_term_id, created_at)
    VALUES ('m1', 'a1', 'u1', 'confirm', 'Confirm', 'Confirm it.', 'p1', 1);
  `);

  const response = await handleMarkingsApi(
    jsonRequest('/api/marked-terms/p1/add-to-word', 'POST', {
      zh: '证实',
      lemma: 'confirm',
      strategy: 'merge',
      targetWordId: 'w1',
      tagIds: ['t-new']
    }),
    { DB }, '/api/marked-terms/p1/add-to-word', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(DB.all(`
    SELECT tag_id FROM word_tags WHERE word_id = 'w1' ORDER BY tag_id
  `), [{ tag_id: 't-new' }, { tag_id: 't-old' }]);
});

test('exports the owned library as Markdown, CSV, or JSON', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  const responses = await Promise.all(['markdown', 'csv', 'json'].map(format =>
    handleWordLibraryApi(
      new Request(`https://app/api/export?format=${format}`),
      { DB }, '/api/export', 'u1'
    )
  ));

  assert.match(await responses[0].text(), /## confirm/);
  assert.match(await responses[1].text(), /"word","meaning"/);
  assert.equal(JSON.parse(await responses[2].text()).words[0].lemma, 'confirm');
});

function seededDb() {
  const DB = createSqliteDb();
  DB.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, NULL, ?)'
  ).bind('u1', 'one', 1).run();
  DB.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, NULL, ?)'
  ).bind('u2', 'two', 1).run();
  insertWord(DB, 'w1', 'u1', 'confirm');
  return DB;
}

function insertWord(DB, id, userId, lemma) {
  DB.prepare(`
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES (?, ?, ?, ?, ?, '', '', 0, ?)
  `).bind(id, userId, lemma, lemma, `${lemma}-zh`, 1).run();
  DB.prepare(`
    INSERT INTO word_review_state
      (word_id, user_id, due_at, stability, difficulty, elapsed_days,
       scheduled_days, learning_steps, reps, lapses, state, last_review_at,
       version, created_at, updated_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 1, 1)
  `).bind(id, userId).run();
}

function jsonRequest(path, method, body) {
  return new Request(`https://app${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
