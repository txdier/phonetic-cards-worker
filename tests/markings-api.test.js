import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWordsApi } from '../src/words-api.js';
import { createFakeDb } from './helpers/fake-db.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('word list includes lemma and forms', async () => {
  const DB = createFakeDb({
    all: [
      { results: [
        { id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署' },
        { id: 'w2', en: 'legacy', lemma: null, zh: '旧词' }
      ] },
      { results: [{ word_id: 'w1', form: 'deployed', normalized_form: 'deployed' }] }
    ]
  });
  const response = await handleWordsApi(
    new Request('https://app/api/words'), { DB }, '/api/words', 'u1'
  );
  const [word, legacyWord] = await response.json();
  assert.equal(word.lemma, 'deploy');
  assert.deepEqual(word.forms.map(item => item.form), ['deployed']);
  assert.equal(legacyWord.lemma, 'legacy');
  assert.deepEqual(legacyWord.forms, []);
  assert.deepEqual(DB.calls.map(call => call.bindings), [['u1'], ['u1']]);
});

test('manual creation stores the normalized lemma and submitted form', async (t) => {
  const DB = createSqliteDb();
  t.after(() => DB.close());
  DB.exec(`
    INSERT INTO users (id, username, created_at)
    VALUES ('u1', 'alice', 1)
  `);
  const request = new Request('https://app/api/words', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      en: '  Deployed  ',
      lemma: '  DePLOY  ',
      zh: '部署',
      example: 'They deployed the service.',
      stress: 'de-PLOY'
    })
  });

  const response = await handleWordsApi(request, { DB }, '/api/words', 'u1');
  const created = await response.json();

  assert.equal(response.status, 201);
  assert.equal(created.en, 'deploy');
  assert.equal(created.lemma, 'deploy');
  assert.deepEqual(created.forms, [
    { form: 'Deployed', normalized_form: 'deployed' }
  ]);
  assert.deepEqual(
    DB.get('SELECT en, lemma, zh, example, stress, familiarity FROM words WHERE id = ?', created.id),
    {
      en: 'deploy',
      lemma: 'deploy',
      zh: '部署',
      example: 'They deployed the service.',
      stress: 'de-PLOY',
      familiarity: 0
    }
  );
  assert.deepEqual(
    DB.get('SELECT word_id, user_id, form, normalized_form FROM word_forms WHERE word_id = ?', created.id),
    {
      word_id: created.id,
      user_id: 'u1',
      form: 'Deployed',
      normalized_form: 'deployed'
    }
  );
});

test('word editing updates owned card fields without resetting learning state', async (t) => {
  const DB = createSqliteDb();
  t.after(() => DB.close());
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'alice', 1);
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, last_tested_at, created_at)
    VALUES ('w1', 'u1', 'deploy', 'deploy', '部署', 'Old example.', 'de-PLOY', 3, 99, 2);
  `);

  const response = await handleWordsApi(
    new Request('https://app/api/words/w1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lemma: '  Launch  ', zh: ' 启动 ', example: 'Launch it.', stress: 'LAUNCH'
      })
    }),
    { DB }, '/api/words/w1', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    DB.get('SELECT en, lemma, zh, example, stress, familiarity, last_tested_at FROM words WHERE id = ?', 'w1'),
    {
      en: 'launch', lemma: 'launch', zh: '启动', example: 'Launch it.', stress: 'LAUNCH',
      familiarity: 3, last_tested_at: 99
    }
  );
  assert.deepEqual(await response.json(), {
    id: 'w1', en: 'launch', lemma: 'launch', zh: '启动', example: 'Launch it.', stress: 'LAUNCH'
  });
});

test('testing a word updates familiarity and last tested time before deletion cascades', async (t) => {
  const DB = createSqliteDb();
  t.after(() => DB.close());
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'alice', 1);
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES ('w1', 'u1', 'deploy', 'deploy', '部署', '', '', 0, 2);
    INSERT INTO word_forms
      (id, word_id, user_id, form, normalized_form, created_at)
    VALUES ('f1', 'w1', 'u1', 'deployed', 'deployed', 2);
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES ('a1', 'u1', 'Article', 'They deployed.', '', '', '', 3, 3);
    INSERT INTO article_markings
      (id, article_id, user_id, normalized_text, selected_text,
       context_sentence, word_id, created_at)
    VALUES ('m1', 'a1', 'u1', 'deployed', 'deployed', 'They deployed.', 'w1', 3);
  `);

  const patchResponse = await handleWordsApi(
    new Request('https://app/api/words/w1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ familiarity: 3 })
    }),
    { DB }, '/api/words/w1', 'u1'
  );
  assert.equal(patchResponse.status, 200);
  const updated = DB.get('SELECT familiarity, last_tested_at FROM words WHERE id = ?', 'w1');
  assert.equal(updated.familiarity, 3);
  assert.equal(Number.isInteger(updated.last_tested_at), true);
  assert.ok(updated.last_tested_at > 0);
  assert.deepEqual(await patchResponse.json(), { ok: true, last_tested_at: updated.last_tested_at });

  const deleteResponse = await handleWordsApi(
    new Request('https://app/api/words/w1', { method: 'DELETE' }),
    { DB }, '/api/words/w1', 'u1'
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(DB.get('SELECT id FROM words WHERE id = ?', 'w1'), null);
  assert.equal(DB.get('SELECT id FROM word_forms WHERE word_id = ?', 'w1'), null);
  assert.equal(DB.get('SELECT id FROM article_markings WHERE word_id = ?', 'w1'), null);
});
