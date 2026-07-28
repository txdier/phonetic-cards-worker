import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken } from '../src/auth.js';
import worker from '../src/index.js';
import { handleProgressApi } from '../src/progress-api.js';
import { handleStatsApi } from '../src/stats-api.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('PATCH clamps the position while preserving every aggregate', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  DB.prepare(`
    UPDATE article_progress
    SET last_position_ratio = 0.25, completed = 1, read_count = 3,
        active_read_ms = 4000, full_read_aloud_count = 2, updated_at = 11
    WHERE article_id = 'a1'
  `).run();

  const response = await handleProgressApi(
    jsonRequest('PATCH', { lastPositionRatio: 1.5 }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(progressRow(DB, 'a1'), {
    last_position_ratio: 1,
    completed: 1,
    read_count: 3,
    active_read_ms: 4000,
    full_read_aloud_count: 2
  });
});

test('PATCH creates missing progress and clamps a negative position to zero', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, false);

  const response = await handleProgressApi(
    jsonRequest('PATCH', { lastPositionRatio: -0.2 }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(progressRow(DB, 'a1'), {
    last_position_ratio: 0,
    completed: 0,
    read_count: 0,
    active_read_ms: 0,
    full_read_aloud_count: 0
  });
});

test('PATCH rejects malformed and non-object position payloads without data effects', async t => {
  const invalidBodies = [
    '{', 'null', '[]', '{}',
    '{"lastPositionRatio":"0.5"}',
    '{"lastPositionRatio":null}',
    '{"lastPositionRatio":NaN}',
    '{"lastPositionRatio":0.5,"lastAloudSentenceIndex":-1}',
    '{"lastPositionRatio":0.5,"lastAloudSentenceIndex":1.5}',
    '{"lastPositionRatio":0.5,"lastAloudSentenceIndex":"2"}'
  ];

  for (const rawBody of invalidBodies) {
    const DB = createSeededDb();
    t.after(() => DB.close());
    insertArticle(DB, 'a1', 'u1', 10, true);
    const before = progressRow(DB, 'a1');
    const response = await handleProgressApi(
      rawRequest('PATCH', rawBody), { DB }, '/api/articles/a1/progress', 'u1'
    );
    assert.equal(response.status, 400, rawBody);
    assert.equal((await response.json()).code, 'INVALID_PROGRESS_BODY', rawBody);
    assert.deepEqual(progressRow(DB, 'a1'), before, rawBody);
  }
});

test('PATCH writes, preserves, and clears the aloud sentence independently', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);

  let response = await handleProgressApi(
    jsonRequest('PATCH', {
      lastPositionRatio: 0.2,
      lastAloudSentenceIndex: 4
    }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );
  assert.equal(response.status, 200);
  assert.equal(DB.get(`
    SELECT last_aloud_sentence_index AS value
    FROM article_progress WHERE article_id = 'a1'
  `).value, 4);

  response = await handleProgressApi(
    jsonRequest('PATCH', { lastPositionRatio: 0.3 }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );
  assert.equal(response.status, 200);
  assert.equal(DB.get(`
    SELECT last_aloud_sentence_index AS value
    FROM article_progress WHERE article_id = 'a1'
  `).value, 4);

  response = await handleProgressApi(
    jsonRequest('PATCH', {
      lastPositionRatio: 0.4,
      lastAloudSentenceIndex: null
    }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );
  assert.equal(response.status, 200);
  assert.equal(DB.get(`
    SELECT last_aloud_sentence_index AS value
    FROM article_progress WHERE article_id = 'a1'
  `).value, null);
});

test('events update real aggregates and preserve the last saved position', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  DB.prepare(`UPDATE article_progress SET last_position_ratio = 0.6 WHERE article_id = 'a1'`).run();

  for (const event of [
    { id: 'active-1', type: 'active_ms', amount: 1234 },
    { id: 'read-1', type: 'read_complete', amount: 1 },
    { id: 'aloud-1', type: 'read_aloud_complete', amount: 1 }
  ]) {
    const response = await handleProgressApi(
      jsonRequest('POST', event), { DB }, '/api/articles/a1/progress/events', 'u1'
    );
    assert.equal(response.status, 200);
  }

  assert.deepEqual(progressRow(DB, 'a1'), {
    last_position_ratio: 0.6,
    completed: 1,
    read_count: 1,
    active_read_ms: 1234,
    full_read_aloud_count: 1
  });
  assert.equal(DB.get(`SELECT count(*) AS count FROM article_progress_events`).count, 3);
});

test('event processing creates missing progress without resetting other values', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, false);

  const response = await handleProgressApi(
    jsonRequest('POST', { id: 'active-1', type: 'active_ms', amount: 500 }),
    { DB }, '/api/articles/a1/progress/events', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(progressRow(DB, 'a1'), {
    last_position_ratio: 0,
    completed: 0,
    read_count: 0,
    active_read_ms: 500,
    full_read_aloud_count: 0
  });
});

test('duplicate event calls increment the aggregate exactly once', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  const event = { id: 'same-event', type: 'read_complete', amount: 1 };

  const responses = [
    await handleProgressApi(
      jsonRequest('POST', event), { DB }, '/api/articles/a1/progress/events', 'u1'
    ),
    await handleProgressApi(
      jsonRequest('POST', event), { DB }, '/api/articles/a1/progress/events', 'u1'
    )
  ];

  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(
    await Promise.all(responses.map(response => response.json())),
    [
      { ok: true, duplicate: false },
      { ok: true, duplicate: true }
    ]
  );
  assert.equal(progressRow(DB, 'a1').read_count, 1);
  assert.equal(DB.get(`SELECT count(*) AS count FROM article_progress_events`).count, 1);
});

test('an aggregate failure rolls back its event so a retry can aggregate it', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  const failAggregateOnceDB = failNextEventAggregate(DB);
  const event = { id: 'retry-event', type: 'read_complete', amount: 1 };

  await assert.rejects(
    handleProgressApi(
      jsonRequest('POST', event), { DB: failAggregateOnceDB },
      '/api/articles/a1/progress/events', 'u1'
    ),
    /forced aggregate failure/
  );
  assert.equal(DB.get(`SELECT count(*) AS count FROM article_progress_events`).count, 0);
  assert.equal(progressRow(DB, 'a1').read_count, 0);

  const retry = await handleProgressApi(
    jsonRequest('POST', event), { DB: failAggregateOnceDB },
    '/api/articles/a1/progress/events', 'u1'
  );
  assert.equal(retry.status, 200);
  assert.equal(DB.get(`SELECT count(*) AS count FROM article_progress_events`).count, 1);
  assert.equal(progressRow(DB, 'a1').read_count, 1);
});

test('POST rejects invalid event payloads without creating events', async t => {
  const invalidBodies = [
    '{', 'null', '[]', '{}',
    JSON.stringify({ id: '', type: 'active_ms', amount: 1 }),
    JSON.stringify({ id: 3, type: 'active_ms', amount: 1 }),
    JSON.stringify({ id: 'e1', type: 'unknown', amount: 1 }),
    JSON.stringify({ id: 'e1', type: 'active_ms', amount: 0 }),
    JSON.stringify({ id: 'e1', type: 'active_ms', amount: 60001 }),
    JSON.stringify({ id: 'e1', type: 'active_ms', amount: 1.5 }),
    JSON.stringify({ id: 'e1', type: 'read_complete', amount: 2 }),
    JSON.stringify({ id: 'e1', type: 'read_aloud_complete', amount: '1' })
  ];

  for (const rawBody of invalidBodies) {
    const DB = createSeededDb();
    t.after(() => DB.close());
    insertArticle(DB, 'a1', 'u1', 10, true);
    const response = await handleProgressApi(
      rawRequest('POST', rawBody), { DB }, '/api/articles/a1/progress/events', 'u1'
    );
    assert.equal(response.status, 400, rawBody);
    assert.equal((await response.json()).code, 'INVALID_PROGRESS_EVENT', rawBody);
    assert.equal(DB.get(`SELECT count(*) AS count FROM article_progress_events`).count, 0);
    assert.deepEqual(progressRow(DB, 'a1'), {
      last_position_ratio: 0,
      completed: 0,
      read_count: 0,
      active_read_ms: 0,
      full_read_aloud_count: 0
    });
  }
});

test('unowned and missing articles return a stable 404 with no effects', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'private', 'u2', 10, true);

  for (const [path, request] of [
    ['/api/articles/private/progress', jsonRequest('PATCH', { lastPositionRatio: 0.8 })],
    ['/api/articles/private/progress/events', jsonRequest('POST', {
      id: 'event-1', type: 'read_complete', amount: 1
    })],
    ['/api/articles/missing/progress', jsonRequest('PATCH', { lastPositionRatio: 0.8 })]
  ]) {
    const response = await handleProgressApi(request, { DB }, path, 'u1');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'ARTICLE_NOT_FOUND');
  }

  assert.deepEqual(progressRow(DB, 'private'), {
    last_position_ratio: 0,
    completed: 0,
    read_count: 0,
    active_read_ms: 0,
    full_read_aloud_count: 0
  });
  assert.equal(DB.get(`SELECT count(*) AS count FROM article_progress_events`).count, 0);
});

test('statistics include progress and explicit marking counts with zero defaults', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'older', 'u1', 10, true);
  insertArticle(DB, 'newer', 'u1', 20, false);
  insertArticle(DB, 'other-user', 'u2', 30, true);
  DB.prepare(`
    UPDATE article_progress
    SET last_position_ratio = 0.7, completed = 1, read_count = 4,
        active_read_ms = 9000, full_read_aloud_count = 2
    WHERE article_id = 'older'
  `).run();
  insertPendingMarking(DB, 'pending-1', 'older', 'u1');
  insertConvertedMarking(DB, 'converted-1', 'older', 'u1');
  insertPendingMarking(DB, 'other-marking', 'other-user', 'u2');

  const response = await handleStatsApi(
    new Request('https://app/api/article-stats'), { DB }, '/api/article-stats', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    {
      id: 'newer', title: 'newer', author: '', source: '', created_at: 20,
      last_position_ratio: 0, completed: 0, read_count: 0,
      active_read_ms: 0, full_read_aloud_count: 0,
      marking_count: 0, pending_marking_count: 0, converted_marking_count: 0
    },
    {
      id: 'older', title: 'older', author: '', source: '', created_at: 10,
      last_position_ratio: 0.7, completed: 1, read_count: 4,
      active_read_ms: 9000, full_read_aloud_count: 2,
      marking_count: 2, pending_marking_count: 1, converted_marking_count: 1
    }
  ]);
});

test('worker routes authenticated progress and stats paths before the words fallback', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  const secret = 'long-test-secret';
  const token = await createSessionToken('u1', secret);
  const auth = { cookie: `session=${token}`, 'content-type': 'application/json' };

  const patchResponse = await worker.fetch(new Request(
    'https://app/api/articles/a1/progress', {
      method: 'PATCH', headers: auth, body: JSON.stringify({ lastPositionRatio: 0.45 })
    }
  ), { DB, AUTH_SECRET: secret });
  const statsResponse = await worker.fetch(new Request(
    'https://app/api/article-stats', { headers: { cookie: `session=${token}` } }
  ), { DB, AUTH_SECRET: secret });

  assert.equal(patchResponse.status, 200);
  assert.equal(progressRow(DB, 'a1').last_position_ratio, 0.45);
  assert.equal(statsResponse.status, 200);
  assert.equal((await statsResponse.json())[0].id, 'a1');
});

function createSeededDb() {
  const DB = createSqliteDb();
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'alice', 1);
    INSERT INTO users (id, username, created_at) VALUES ('u2', 'bob', 1);
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES ('w1', 'u1', 'word', 'word', 'word', '', '', 0, 1);
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES ('w2', 'u2', 'word', 'word', 'word', '', '', 0, 1);
  `);
  return DB;
}

function insertArticle(DB, id, userId, createdAt, withProgress) {
  DB.prepare(`
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES (?, ?, ?, 'Body', '', '', '', ?, ?)
  `).bind(id, userId, id, createdAt, createdAt).run();
  if (withProgress) {
    DB.prepare(`
      INSERT INTO article_progress
        (article_id, user_id, last_position_ratio, completed, read_count,
         active_read_ms, full_read_aloud_count, updated_at)
      VALUES (?, ?, 0, 0, 0, 0, 0, ?)
    `).bind(id, userId, createdAt).run();
  }
}

function insertPendingMarking(DB, id, articleId, userId) {
  const termId = `term-${id}`;
  DB.prepare(`
    INSERT INTO marked_terms
      (id, user_id, display_text, normalized_text, kind, created_at)
    VALUES (?, ?, ?, ?, 'word', 1)
  `).bind(termId, userId, id, id).run();
  DB.prepare(`
    INSERT INTO article_markings
      (id, article_id, user_id, normalized_text, selected_text,
       context_sentence, marked_term_id, word_id, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, NULL, 1)
  `).bind(id, articleId, userId, id, id, termId).run();
}

function insertConvertedMarking(DB, id, articleId, userId) {
  DB.prepare(`
    INSERT INTO article_markings
      (id, article_id, user_id, normalized_text, selected_text,
       context_sentence, marked_term_id, word_id, created_at)
    VALUES (?, ?, ?, ?, ?, '', NULL, ?, 1)
  `).bind(id, articleId, userId, id, id, userId === 'u1' ? 'w1' : 'w2').run();
}

function progressRow(DB, articleId) {
  return DB.get(`
    SELECT last_position_ratio, completed, read_count, active_read_ms,
           full_read_aloud_count
    FROM article_progress WHERE article_id = ?
  `, articleId);
}

function failNextEventAggregate(DB) {
  let shouldFail = true;
  return {
    ...DB,
    prepare(sql) {
      const statement = DB.prepare(sql);
      if (!sql.includes('read_count = article_progress.read_count')) {
        return statement;
      }
      const failOnce = () => {
        if (!shouldFail) return false;
        shouldFail = false;
        throw new Error('forced aggregate failure');
      };
      return {
        bind(...values) { statement.bind(...values); return this; },
        first: () => statement.first(),
        all: () => statement.all(),
        async run() { failOnce(); return statement.run(); },
        async batchRun() { failOnce(); return statement.batchRun(); }
      };
    },
    batch(statements) { return DB.batch(statements); }
  };
}

function jsonRequest(method, body) {
  return rawRequest(method, JSON.stringify(body));
}

function rawRequest(method, body) {
  return new Request('https://app/api', {
    method,
    headers: { 'content-type': 'application/json' },
    body
  });
}
