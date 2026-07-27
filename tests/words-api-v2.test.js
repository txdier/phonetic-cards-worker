import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWordsApi } from '../src/words-api.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('word list returns pagination metadata and applies keyword and due filters', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  insertWord(DB, 'w1', 'confirm', 0);
  insertWord(DB, 'w2', 'deploy', Date.now() + 86_400_000);

  const response = await handleWordsApi(
    new Request('https://app/api/words?keyword=conf&due=1&page=1&pageSize=10'),
    { DB }, '/api/words', 'u1'
  );
  const payload = await response.json();

  assert.equal(payload.total, 1);
  assert.equal(payload.page, 1);
  assert.equal(payload.pageSize, 10);
  assert.deepEqual(payload.words.map(word => word.id), ['w1']);
  assert.equal('familiarity' in payload.words[0], false);
});

test('manual creation initializes FSRS state and returns assigned tags', async t => {
  const DB = seededDb();
  t.after(() => DB.close());
  DB.prepare(`
    INSERT INTO tags (id, user_id, name, normalized_name, created_at)
    VALUES ('t1', 'u1', '工作', '工作', 1)
  `).run();
  const response = await handleWordsApi(
    jsonRequest('/api/words', 'POST', {
      en: 'Deployed',
      lemma: 'deploy',
      zh: '部署',
      example: 'They deployed it.',
      stress: 'de-PLOY',
      tagIds: ['t1']
    }),
    { DB }, '/api/words', 'u1'
  );
  const word = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(word.tags, [{ id: 't1', name: '工作' }]);
  assert.deepEqual(DB.get(`
    SELECT state, reps, version FROM word_review_state WHERE word_id = ?
  `, word.id), { state: 0, reps: 0, version: 0 });
});

function seededDb() {
  const DB = createSqliteDb();
  DB.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, NULL, ?)'
  ).bind('u1', 'one', 1).run();
  return DB;
}

function insertWord(DB, id, lemma, dueAt) {
  DB.prepare(`
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES (?, 'u1', ?, ?, ?, '', '', 0, 1)
  `).bind(id, lemma, lemma, `${lemma}-zh`).run();
  DB.prepare(`
    INSERT INTO word_review_state
      (word_id, user_id, due_at, stability, difficulty, elapsed_days,
       scheduled_days, learning_steps, reps, lapses, state, last_review_at,
       version, created_at, updated_at)
    VALUES (?, 'u1', ?, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, 1, 1)
  `).bind(id, dueAt).run();
}

function jsonRequest(path, method, body) {
  return new Request(`https://app${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
