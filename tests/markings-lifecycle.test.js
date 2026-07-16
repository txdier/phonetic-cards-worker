import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createSessionToken } from '../src/auth.js';
import { appendMeaning, handleMarkingsApi } from '../src/markings-api.js';
import { createFakeDb } from './helpers/fake-db.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('appendMeaning appends only a new Chinese meaning', () => {
  assert.equal(appendMeaning('部署；配置', '发布'), '部署；配置；发布');
  assert.equal(appendMeaning('部署；配置', ' 配置 '), '部署；配置');
  assert.equal(appendMeaning('', '发布'), '发布');
  assert.equal(appendMeaning('base；one；', ' one；two；two '), 'base；one；two');
  assert.equal(appendMeaning('base；', '；；'), 'base');
});

test('pending list is user-scoped and includes source counts', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertArticle(DB, 'a1', 'u1', 'They deploy.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deploy', 't1');
  insertPending(DB, 't2', 'u2', 'private');

  const response = await call(DB, 'GET', '/api/marked-terms', 'u1');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    id: 't1', display_text: 'deploy', normalized_text: 'deploy',
    kind: 'word', created_at: 1, source_count: 1, context_sentence: 'deploy.'
  }]);
});

test('pending list exposes the latest owned context sentence without leaking another user', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertPending(DB, 't2', 'u2', 'private');
  insertArticle(DB, 'a1', 'u1', 'First deploy.');
  insertArticle(DB, 'a2', 'u1', 'Latest deploy.');
  insertArticle(DB, 'a3', 'u2', 'Private context.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deploy', 't1');
  insertMarking(DB, 'm2', 'a2', 'u1', 'deploy', 't1');
  insertMarking(DB, 'm3', 'a3', 'u2', 'private', 't2');
  DB.exec(`
    UPDATE article_markings SET context_sentence = 'Older context.', created_at = 10 WHERE id = 'm1';
    UPDATE article_markings SET context_sentence = 'Latest context.', created_at = 20 WHERE id = 'm2';
    UPDATE article_markings SET context_sentence = 'Private context.', created_at = 30 WHERE id = 'm3';
  `);

  const response = await call(DB, 'GET', '/api/marked-terms', 'u1');
  const rows = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(rows.map(row => ({
    id: row.id,
    source_count: row.source_count,
    context_sentence: row.context_sentence
  })), [{ id: 't1', source_count: 2, context_sentence: 'Latest context.' }]);
});

test('worker routes pending and article marking endpoints to the markings handler', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertArticle(DB, 'a1', 'u1', 'They deploy safely.');
  const secret = 'task-7-test-secret';
  const token = await createSessionToken('u1', secret);
  const env = { DB, AUTH_SECRET: secret };

  const list = await worker.fetch(new Request('https://app/api/marked-terms', {
    headers: { cookie: `session=${token}` }
  }), env);
  assert.equal(list.status, 200);
  assert.equal((await list.json())[0].id, 't1');

  const create = await worker.fetch(new Request('https://app/api/articles/a1/markings', {
    method: 'POST',
    headers: {
      cookie: `session=${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ selectedText: 'deploy', contextSentence: 'They deploy safely.' })
  }), env);
  assert.equal(create.status, 201);
});

test('existing global pending creates one new source and duplicate source is idempotent', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertArticle(DB, 'a1', 'u1', 'They deploy safely.');

  const body = {
    selectedText: 'Deploy', normalizedText: 'wrong-client-value',
    contextSentence: 'They deploy safely.'
  };
  const first = await call(DB, 'POST', '/api/articles/a1/markings', 'u1', body);
  const firstBody = await first.json();
  const duplicate = await call(DB, 'POST', '/api/articles/a1/markings', 'u1', body);
  const duplicateBody = await duplicate.json();

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal(firstBody.id, duplicateBody.id);
  assert.equal(firstBody.marked_term_id, 't1');
  assert.equal(DB.all('SELECT id FROM marked_terms WHERE user_id = ?', 'u1').length, 1);
  assert.equal(DB.all('SELECT id FROM article_markings WHERE article_id = ?', 'a1').length, 1);
});

test('concurrent first marking converges on one pending term and one source', async (t) => {
  const DB = seededDb(t);
  insertArticle(DB, 'a1', 'u1', 'They deploy safely.');
  const concurrentDB = pauseFirstCalls(
    DB, /FROM article_markings WHERE article_id = \? AND normalized_text = \?/, 2
  );
  const input = { selectedText: 'deploy', contextSentence: 'They deploy safely.' };

  const results = await Promise.allSettled([
    call(concurrentDB, 'POST', '/api/articles/a1/markings', 'u1', input),
    call(concurrentDB, 'POST', '/api/articles/a1/markings', 'u1', input)
  ]);

  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.deepEqual(
    results.map(result => result.value.status).sort(),
    [200, 201]
  );
  assert.equal(DB.all('SELECT id FROM marked_terms WHERE user_id = ?', 'u1').length, 1);
  assert.equal(DB.all('SELECT id FROM article_markings WHERE article_id = ?', 'a1').length, 1);
});

test('marking returns the canonical source selected inside its creation batch', async (t) => {
  const DB = seededDb(t);
  insertArticle(DB, 'a1', 'u1', 'They deploy safely.');
  const batchOnlyCanonicalDB = rejectCanonicalReadAfterBatch(DB);

  const response = await call(
    batchOnlyCanonicalDB, 'POST', '/api/articles/a1/markings', 'u1',
    { selectedText: 'deploy', contextSentence: 'They deploy safely.' }
  );
  const body = await response.json();
  const stored = DB.get(
    'SELECT id, marked_term_id FROM article_markings WHERE article_id = ?', 'a1'
  );

  assert.equal(response.status, 201);
  assert.equal(body.id, stored.id);
  assert.equal(body.marked_term_id, stored.marked_term_id);
});

test('marking validates article ownership and term occurrence', async (t) => {
  const DB = seededDb(t);
  insertArticle(DB, 'a1', 'u2', 'They deploy safely.');
  const input = { selectedText: 'missing', normalizedText: 'missing', contextSentence: '' };

  const notOwned = await call(DB, 'POST', '/api/articles/a1/markings', 'u1', input);
  assert.equal(notOwned.status, 404);

  insertArticle(DB, 'a2', 'u1', 'They deploy safely.');
  const absent = await call(DB, 'POST', '/api/articles/a2/markings', 'u1', input);
  assert.equal(absent.status, 400);
  assert.equal((await absent.json()).code, 'TERM_NOT_IN_ARTICLE');
  assert.equal(DB.all('SELECT id FROM marked_terms').length, 0);
});

test('marking rejects malformed and non-object JSON without changing state', async (t) => {
  const DB = seededDb(t);
  insertArticle(DB, 'a1', 'u1', 'They deploy safely.');

  for (const rawBody of ['{', 'null', '[]']) {
    const response = await callRaw(DB, 'POST', '/api/articles/a1/markings', 'u1', rawBody);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_BODY');
  }
  assert.equal(DB.all('SELECT id FROM marked_terms').length, 0);
  assert.equal(DB.all('SELECT id FROM article_markings').length, 0);
});

test('marking rejects non-string schema fields', async (t) => {
  const DB = seededDb(t);
  insertArticle(DB, 'a1', 'u1', 'They deploy safely.');
  for (const body of [
    { selectedText: {}, contextSentence: '' },
    { selectedText: 'deploy', normalizedText: [], contextSentence: '' },
    { selectedText: 'deploy', contextSentence: 42 }
  ]) {
    const response = await call(DB, 'POST', '/api/articles/a1/markings', 'u1', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_BODY');
  }
  assert.equal(DB.all('SELECT id FROM marked_terms').length, 0);
});

test('removing the last article source deletes its pending term', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertArticle(DB, 'a1', 'u1', 'Deploy.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deploy', 't1');

  const response = await call(DB, 'DELETE', '/api/articles/a1/markings/m1', 'u1');
  assert.equal(response.status, 200);
  assert.equal(DB.get('SELECT id FROM article_markings WHERE id = ?', 'm1'), null);
  assert.equal(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), null);
});

test('removing one of two article sources preserves the shared pending term', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertArticle(DB, 'a1', 'u1', 'Deploy.');
  insertArticle(DB, 'a2', 'u1', 'Deploy again.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deploy', 't1');
  insertMarking(DB, 'm2', 'a2', 'u1', 'deploy', 't1');

  const response = await call(DB, 'DELETE', '/api/articles/a1/markings/m1', 'u1');
  assert.equal(response.status, 200);
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), { id: 't1' });
  assert.deepEqual(DB.all('SELECT id FROM article_markings WHERE marked_term_id = ?', 't1'), [{ id: 'm2' }]);
});

test('article-local delete cannot remove another user source', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't2', 'u2', 'deploy');
  insertArticle(DB, 'a2', 'u2', 'Deploy.');
  insertMarking(DB, 'm2', 'a2', 'u2', 'deploy', 't2');

  const response = await call(DB, 'DELETE', '/api/articles/a2/markings/m2', 'u1');
  assert.equal(response.status, 404);
  assert.deepEqual(DB.get('SELECT id FROM article_markings WHERE id = ?', 'm2'), { id: 'm2' });
});

test('global cancellation deletes every source and the pending row', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deploy');
  insertArticle(DB, 'a1', 'u1', 'Deploy.');
  insertArticle(DB, 'a2', 'u1', 'Deploy again.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deploy', 't1');
  insertMarking(DB, 'm2', 'a2', 'u1', 'deploy', 't1');

  const response = await call(DB, 'DELETE', '/api/marked-terms/t1', 'u1');
  assert.equal(response.status, 200);
  assert.equal(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), null);
  assert.deepEqual(DB.all('SELECT id FROM article_markings WHERE marked_term_id = ?', 't1'), []);
});

test('global cancellation verifies pending ownership and binds userId to every query', async () => {
  const DB = createFakeDb({ first: [{ id: 't1' }] });
  const response = await call(DB, 'DELETE', '/api/marked-terms/t1', 'u1');
  assert.equal(response.status, 200);
  assert.ok(DB.calls.length >= 3);
  assert.ok(DB.calls.every(call => call.bindings.includes('u1')));
  assert.match(DB.calls.at(-2).sql, /DELETE FROM article_markings/);
  assert.match(DB.calls.at(-1).sql, /DELETE FROM marked_terms/);
});

test('same lemma returns a resolvable conflict without changing state', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed', 'deployed');
  insertWord(DB, 'w1', 'u1', 'deploy', '部署', 'Old example.');

  const response = await call(DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
    zh: '发布', lemma: 'deploy', example: 'New example.'
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'LEMMA_EXISTS');
  assert.deepEqual(body.matches.map(item => item.id), ['w1']);
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), { id: 't1' });
  assert.equal(DB.get('SELECT zh FROM words WHERE id = ?', 'w1').zh, '部署');
});

test('conversion rejects malformed and non-object JSON without changing state', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');

  for (const rawBody of ['{', 'null', '[]']) {
    const response = await callRaw(
      DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', rawBody
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_BODY');
  }
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), { id: 't1' });
});

test('conversion rejects malformed schema fields', async (t) => {
  const cases = [
    { zh: {} },
    { zh: '发布', lemma: [] },
    { zh: '发布', strategy: 1 },
    { zh: '发布', strategy: '' },
    { zh: '发布', strategy: 'merge', targetWordId: {} },
    { zh: '发布', example: false },
    { zh: '发布', stress: [] }
  ];
  for (const [index, body] of cases.entries()) {
    const DB = seededDb(t);
    insertPending(DB, `t${index}`, 'u1', 'deployed');
    const response = await call(
      DB, 'POST', `/api/marked-terms/t${index}/add-to-word`, 'u1', body
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_BODY');
    assert.deepEqual(DB.get(
      'SELECT id FROM marked_terms WHERE id = ?', `t${index}`
    ), { id: `t${index}` });
  }
});

test('merge adds a form and meaning, retains example, and converts every source atomically', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed', 'deployed');
  insertWord(DB, 'w1', 'u1', 'deploy', '部署；配置', 'Old example.');
  insertArticle(DB, 'a1', 'u1', 'They deployed.');
  insertArticle(DB, 'a2', 'u1', 'Deployed again.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deployed', 't1');
  insertMarking(DB, 'm2', 'a2', 'u1', 'deployed', 't1');

  const response = await call(DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
    zh: '发布', lemma: 'deploy', example: 'New example.', stress: 'de-PLOY',
    strategy: 'merge', targetWordId: 'w1'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(DB.get('SELECT zh, example FROM words WHERE id = ?', 'w1'), {
    zh: '部署；配置；发布', example: 'Old example.'
  });
  assert.deepEqual(DB.get('SELECT word_id, user_id, form, normalized_form FROM word_forms WHERE normalized_form = ?', 'deployed'), {
    word_id: 'w1', user_id: 'u1', form: 'deployed', normalized_form: 'deployed'
  });
  assert.deepEqual(DB.all('SELECT marked_term_id, word_id FROM article_markings ORDER BY id'), [
    { marked_term_id: null, word_id: 'w1' },
    { marked_term_id: null, word_id: 'w1' }
  ]);
  assert.equal(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), null);
});

test('merge success follows the pending claim rather than a deduplicated business write', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertWord(DB, 'w1', 'u1', 'deploy', '部署', 'Old example.');
  DB.prepare(`INSERT INTO word_forms
    (id, word_id, user_id, form, normalized_form, created_at)
    VALUES ('f1', 'w1', 'u1', 'deployed', 'deployed', 1)`
  ).run();
  const deduplicatingDB = {
    ...DB,
    async batch(statements) {
      const results = await DB.batch(statements);
      results[0].meta.changes = 0;
      return results;
    }
  };

  const response = await call(
    deduplicatingDB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1',
    { zh: '部署', lemma: 'deploy', strategy: 'merge', targetWordId: 'w1' }
  );

  assert.equal(response.status, 200);
  assert.equal(DB.all('SELECT id FROM word_forms WHERE word_id = ?', 'w1').length, 1);
  assert.equal(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), null);
});

test('concurrent merges append distinct meanings from the latest target state', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertPending(DB, 't2', 'u1', 'deploying');
  insertWord(DB, 'w1', 'u1', 'deploy', 'base', 'Old example.');
  const concurrentDB = pauseFirstCalls(
    DB, /FROM words WHERE id = \? AND lemma = \? AND user_id = \?/, 2
  );

  const responses = await Promise.all([
    call(concurrentDB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
      zh: 'one', lemma: 'deploy', strategy: 'merge', targetWordId: 'w1'
    }),
    call(concurrentDB, 'POST', '/api/marked-terms/t2/add-to-word', 'u1', {
      zh: 'two', lemma: 'deploy', strategy: 'merge', targetWordId: 'w1'
    })
  ]);
  const bodies = await Promise.all(responses.map(response => response.json()));

  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.ok(bodies[0].zh.split('；').includes('one'));
  assert.ok(bodies[1].zh.split('；').includes('two'));
  assert.deepEqual(
    DB.get('SELECT zh FROM words WHERE id = ?', 'w1').zh.split('；').sort(),
    ['base', 'one', 'two']
  );
  assert.equal(DB.all('SELECT id FROM marked_terms WHERE user_id = ?', 'u1').length, 0);
});

test('SQL merge normalizes meanings exactly like appendMeaning', async (t) => {
  const cases = [
    { existing: 'base；\tconfig\n', addition: 'config', expected: 'base；config' },
    { existing: 'base；', addition: 'new', expected: 'base；new' },
    { existing: '；；', addition: 'new', expected: 'new' },
    { existing: 'base；\u3000config\u3000', addition: 'config', expected: 'base；config' },
    { existing: 'base；base；', addition: 'base', expected: 'base；base' },
    { existing: 'base；one；two', addition: 'one；two', expected: 'base；one；two' },
    { existing: 'base；one；two', addition: 'two；three', expected: 'base；one；two；three' }
  ];

  for (const { existing, addition, expected } of cases) {
    const DB = seededDb(t);
    insertPending(DB, 't1', 'u1', 'deployed');
    insertWord(DB, 'w1', 'u1', 'deploy', existing, 'Old example.');

    const response = await call(DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
      zh: addition, lemma: 'deploy', strategy: 'merge', targetWordId: 'w1'
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.zh, expected);
    assert.equal(DB.get('SELECT zh FROM words WHERE id = ?', 'w1').zh, expected);
  }
});

test('concurrent compound merges append each incoming meaning only once', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertPending(DB, 't2', 'u1', 'deploying');
  insertWord(DB, 'w1', 'u1', 'deploy', 'base', 'Old example.');
  const concurrentDB = pauseFirstCalls(
    DB, /FROM words WHERE id = \? AND lemma = \? AND user_id = \?/, 2
  );
  const input = {
    zh: 'one；two；one', lemma: 'deploy', strategy: 'merge', targetWordId: 'w1'
  };

  const responses = await Promise.all([
    call(concurrentDB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', input),
    call(concurrentDB, 'POST', '/api/marked-terms/t2/add-to-word', 'u1', input)
  ]);

  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(DB.get('SELECT zh FROM words WHERE id = ?', 'w1').zh, 'base；one；two');
  assert.equal(DB.all('SELECT id FROM marked_terms WHERE user_id = ?', 'u1').length, 0);
});

test('merge rolls back every data effect when its transaction fails', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertWord(DB, 'w1', 'u1', 'deploy', '部署', 'Old example.');
  insertArticle(DB, 'a1', 'u1', 'They deployed.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deployed', 't1');
  const transactionFailingDb = {
    ...DB,
    batch(statements) {
      return DB.batch([
        ...statements,
        DB.prepare(`INSERT INTO marked_terms
          (id, user_id, display_text, normalized_text, kind, created_at)
          VALUES ('forced-failure', 'missing-user', 'x', 'x', 'word', 1)`)
      ]);
    }
  };

  await assert.rejects(() => call(
    transactionFailingDb, 'POST', '/api/marked-terms/t1/add-to-word', 'u1',
    { zh: '发布', lemma: 'deploy', strategy: 'merge', targetWordId: 'w1' }
  ), /FOREIGN KEY constraint failed/);

  assert.deepEqual(DB.get('SELECT zh, example FROM words WHERE id = ?', 'w1'), {
    zh: '部署', example: 'Old example.'
  });
  assert.equal(DB.get('SELECT id FROM word_forms WHERE normalized_form = ?', 'deployed'), null);
  assert.deepEqual(DB.get(
    'SELECT marked_term_id, word_id FROM article_markings WHERE id = ?', 'm1'
  ), { marked_term_id: 't1', word_id: null });
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), { id: 't1' });
});

test('merge rejects a target owned by another user without changing sources', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed', 'deployed');
  insertWord(DB, 'w2', 'u2', 'deploy', '部署', 'Private.');

  const response = await call(DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
    zh: '发布', lemma: 'deploy', strategy: 'merge', targetWordId: 'w2'
  });
  assert.equal(response.status, 404);
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), { id: 't1' });
});

test('merge rejects an owned target that is not a same-lemma conflict candidate', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertWord(DB, 'w1', 'u1', 'deploy', '部署', 'Deploy example.');
  insertWord(DB, 'w2', 'u1', 'cat', '猫', 'Cat example.');

  const response = await call(DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
    zh: '发布', lemma: 'deploy', strategy: 'merge', targetWordId: 'w2'
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'WORD_NOT_FOUND');
  assert.equal(DB.get('SELECT zh FROM words WHERE id = ?', 'w2').zh, '猫');
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), { id: 't1' });
});

test('new strategy creates a separate card and form then converts all sources', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed', 'Deployed');
  insertWord(DB, 'w1', 'u1', 'deploy', '部署', 'Old example.');
  insertArticle(DB, 'a1', 'u1', 'They deployed.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deployed', 't1');

  const response = await call(DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', {
    zh: '发布', lemma: 'deploy', example: 'They deployed.', stress: 'de-PLOY', strategy: 'new'
  });
  const created = await response.json();

  assert.equal(response.status, 201);
  assert.notEqual(created.id, 'w1');
  assert.deepEqual(DB.get('SELECT user_id, en, lemma, zh, example FROM words WHERE id = ?', created.id), {
    user_id: 'u1', en: 'deploy', lemma: 'deploy', zh: '发布', example: 'They deployed.'
  });
  assert.deepEqual(DB.get('SELECT form, normalized_form FROM word_forms WHERE word_id = ?', created.id), {
    form: 'Deployed', normalized_form: 'deployed'
  });
  assert.deepEqual(DB.get('SELECT marked_term_id, word_id FROM article_markings WHERE id = ?', 'm1'), {
    marked_term_id: null, word_id: created.id
  });
  assert.equal(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't1'), null);
});

test('new strategy stores canonical compound meanings and rejects an empty list', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertPending(DB, 't2', 'u1', 'deploying');

  const createdResponse = await call(
    DB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1',
    { zh: ' one ；\u3000two\u3000；one；；', lemma: 'deploy', strategy: 'new' }
  );
  const created = await createdResponse.json();
  const emptyResponse = await call(
    DB, 'POST', '/api/marked-terms/t2/add-to-word', 'u1',
    { zh: '； \u3000；', lemma: 'deploy', strategy: 'new' }
  );

  assert.equal(createdResponse.status, 201);
  assert.equal(created.zh, 'one；two');
  assert.equal(DB.get('SELECT zh FROM words WHERE id = ?', created.id).zh, 'one；two');
  assert.equal(emptyResponse.status, 400);
  assert.equal((await emptyResponse.json()).code, 'INVALID_BODY');
  assert.deepEqual(DB.get('SELECT id FROM marked_terms WHERE id = ?', 't2'), { id: 't2' });
});

test('concurrent new conversion creates only one card and rejects the stale claim', async (t) => {
  const DB = seededDb(t);
  insertPending(DB, 't1', 'u1', 'deployed');
  insertArticle(DB, 'a1', 'u1', 'They deployed.');
  insertMarking(DB, 'm1', 'a1', 'u1', 'deployed', 't1');
  const concurrentDB = pauseFirstCalls(
    DB, /FROM marked_terms WHERE id = \? AND user_id = \?/, 2
  );
  const input = { zh: '部署', lemma: 'deploy', strategy: 'new' };

  const responses = await Promise.all([
    call(concurrentDB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', input),
    call(concurrentDB, 'POST', '/api/marked-terms/t1/add-to-word', 'u1', input)
  ]);

  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(DB.all('SELECT id FROM words WHERE user_id = ?', 'u1').length, 1);
  assert.equal(DB.all('SELECT id FROM word_forms WHERE user_id = ?', 'u1').length, 1);
  assert.deepEqual(DB.get(
    'SELECT marked_term_id, word_id FROM article_markings WHERE id = ?', 'm1'
  ).marked_term_id, null);
});

async function call(DB, method, path, userId, body) {
  const request = new Request(`https://app${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return handleMarkingsApi(request, { DB }, path, userId);
}

async function callRaw(DB, method, path, userId, body) {
  const request = new Request(`https://app${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body
  });
  return handleMarkingsApi(request, { DB }, path, userId);
}

function seededDb(t) {
  const DB = createSqliteDb();
  t.after(() => DB.close());
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'alice', 1);
    INSERT INTO users (id, username, created_at) VALUES ('u2', 'bob', 1);
  `);
  return DB;
}

function insertArticle(DB, id, userId, body) {
  DB.prepare(`INSERT INTO articles
    (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES (?, ?, 'Article', ?, '', '', '', 1, 1)`
  ).bind(id, userId, body).run();
}

function insertPending(DB, id, userId, normalizedText, displayText = normalizedText) {
  DB.prepare(`INSERT INTO marked_terms
    (id, user_id, display_text, normalized_text, kind, created_at)
    VALUES (?, ?, ?, ?, ?, 1)`
  ).bind(id, userId, displayText, normalizedText, normalizedText.includes(' ') ? 'phrase' : 'word').run();
}

function insertMarking(DB, id, articleId, userId, normalizedText, pendingId) {
  DB.prepare(`INSERT INTO article_markings
    (id, article_id, user_id, normalized_text, selected_text, context_sentence, marked_term_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(id, articleId, userId, normalizedText, normalizedText, `${normalizedText}.`, pendingId).run();
}

function insertWord(DB, id, userId, lemma, zh, example) {
  DB.prepare(`INSERT INTO words
    (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '', 0, 1)`
  ).bind(id, userId, lemma, lemma, zh, example).run();
}

function pauseFirstCalls(DB, sqlPattern, count) {
  let arrivals = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let batchTail = Promise.resolve();
  return {
    ...DB,
    async batch(statements) {
      const previous = batchTail;
      let releaseBatch;
      batchTail = new Promise(resolve => { releaseBatch = resolve; });
      await previous;
      try {
        return await DB.batch(statements);
      } finally {
        releaseBatch();
      }
    },
    prepare(sql) {
      const statement = DB.prepare(sql);
      if (!sqlPattern.test(sql.replace(/\s+/g, ' '))) return statement;
      return {
        bind(...values) {
          statement.bind(...values);
          return this;
        },
        async first() {
          const result = await statement.first();
          arrivals += 1;
          if (arrivals === count) release();
          await barrier;
          return result;
        },
        all: () => statement.all(),
        run: () => statement.run(),
        batchRun: () => statement.batchRun()
      };
    }
  };
}

function rejectCanonicalReadAfterBatch(DB) {
  let batchFinished = false;
  return {
    ...DB,
    async batch(statements) {
      const results = await DB.batch(statements);
      batchFinished = true;
      return results;
    },
    prepare(sql) {
      const statement = DB.prepare(sql);
      if (!/SELECT id, article_id, normalized_text, selected_text, context_sentence/.test(
        sql.replace(/\s+/g, ' ')
      )) return statement;
      return {
        bind(...values) {
          statement.bind(...values);
          return this;
        },
        async first() {
          if (batchFinished) throw new Error('canonical source was read after batch');
          return statement.first();
        },
        all: () => statement.all(),
        run: () => statement.run(),
        batchRun: () => statement.batchRun()
      };
    }
  };
}
