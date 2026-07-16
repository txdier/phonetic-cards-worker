import test from 'node:test';
import assert from 'node:assert/strict';
import { handleArticlesApi } from '../src/articles-api.js';
import { createSessionToken } from '../src/auth.js';
import worker from '../src/index.js';
import { createFakeDb } from './helpers/fake-db.js';

test('article list binds the authenticated user', async () => {
  const DB = createFakeDb({ all: [{ results: [] }] });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles'), { DB }, '/api/articles', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(DB.calls[0].bindings, ['u1']);
});

test('creation rejects blank title and body', async () => {
  const DB = createFakeDb();
  const request = new Request('https://app/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: ' ', body: '' })
  });
  const response = await handleArticlesApi(
    request, { DB }, '/api/articles', 'u1'
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'ARTICLE_REQUIRED_FIELDS');
  assert.equal(DB.calls.length, 0);
});

test('creation rejects a null JSON payload', async () => {
  const DB = createFakeDb();
  const response = await handleArticlesApi(
    new Request('https://app/api/articles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null'
    }),
    { DB }, '/api/articles', 'u1'
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'ARTICLE_REQUIRED_FIELDS');
  assert.equal(DB.calls.length, 0);
});

test('article list omits body and returns a stable progress summary', async () => {
  const DB = createFakeDb({ all: [{ results: [{
    id: 'a1', title: 'Title', body: 'must not leak', author: 'Author', source: '', notes: '',
    created_at: 10, updated_at: 20, last_position_ratio: 0.4, completed: 1,
    read_count: 2, active_read_ms: 3000, full_read_aloud_count: 1,
    progress_updated_at: 19
  }] }] });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles'), { DB }, '/api/articles', 'u1'
  );

  assert.deepEqual(await response.json(), [{
    id: 'a1', title: 'Title', author: 'Author', source: '', notes: '',
    created_at: 10, updated_at: 20,
    progress: {
      last_position_ratio: 0.4, completed: 1, read_count: 2,
      active_read_ms: 3000, full_read_aloud_count: 1, updated_at: 19
    }
  }]);
});

test('creation normalizes fields and atomically creates zeroed progress', async () => {
  const DB = createFakeDb();
  const request = new Request('https://app/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '  A title  ', body: '  first\r\nsecond  ', author: ' Writer ',
      source: ' Source ', notes: ' Notes '
    })
  });
  const response = await handleArticlesApi(request, { DB }, '/api/articles', 'u1');
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(
    { title: result.title, body: result.body, author: result.author, source: result.source, notes: result.notes },
    { title: 'A title', body: 'first\nsecond', author: 'Writer', source: 'Source', notes: 'Notes' }
  );
  assert.deepEqual(result.progress, {
    last_position_ratio: 0, completed: 0, read_count: 0,
    active_read_ms: 0, full_read_aloud_count: 0, updated_at: result.updated_at
  });
  assert.equal(DB.batches.length, 1);
  assert.equal(DB.batches[0].length, 2);
  assert.deepEqual(DB.calls[0].bindings, [
    result.id, 'u1', 'A title', 'first\nsecond', 'Writer', 'Source', 'Notes',
    result.created_at, result.updated_at
  ]);
  assert.deepEqual(DB.calls[1].bindings, [result.id, 'u1', result.updated_at]);
});

test('article detail returns reader data with every query scoped to the user', async () => {
  const DB = createFakeDb({
    first: [{
      id: 'a1', title: 'Title', body: 'Read deploy.', author: '', source: '', notes: '',
      created_at: 10, updated_at: 20, last_position_ratio: 0.25, completed: 0,
      read_count: 1, active_read_ms: 400, full_read_aloud_count: 0,
      progress_updated_at: 21
    }],
    all: [
      { results: [{
        id: 'm1', normalized_text: 'deploy', selected_text: 'deploy',
        context_sentence: 'Read deploy.', marked_term_id: 't1', word_id: null, created_at: 12
      }] },
      { results: [{
        id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', created_at: 11
      }] },
      { results: [
        { word_id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署', example: '', stress: 'de-PLOY', form_id: 'f1', form: 'deploy', normalized_form: 'deploy' },
        { word_id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署', example: '', stress: 'de-PLOY', form_id: 'f2', form: 'deployed', normalized_form: 'deployed' }
      ] }
    ]
  });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles/a1'), { DB }, '/api/articles/a1', 'u1'
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.body, 'Read deploy.');
  assert.deepEqual(result.progress, {
    last_position_ratio: 0.25, completed: 0, read_count: 1,
    active_read_ms: 400, full_read_aloud_count: 0, updated_at: 21
  });
  assert.equal(result.markings[0].marked_term_id, 't1');
  assert.equal(result.pending_terms[0].normalized_text, 'deploy');
  assert.deepEqual(result.words[0].forms.map(item => item.form), ['deploy', 'deployed']);
  assert.equal(DB.calls.length, 4);
  assert.ok(DB.calls.every(call => call.bindings.includes('u1')));
});

test('article detail hides articles not owned by the user', async () => {
  const DB = createFakeDb({ first: [null] });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles/a1'), { DB }, '/api/articles/a1', 'u2'
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'ARTICLE_NOT_FOUND');
  assert.deepEqual(DB.calls[0].bindings, ['a1', 'u2']);
  assert.equal(DB.calls.length, 1);
});

test('editing removes missing explicit sources and only orphan pending terms', async () => {
  const current = {
    id: 'a1', title: 'Old', body: 'Keep deploy and remove obsolete.', author: '',
    source: '', notes: '', created_at: 10, updated_at: 10
  };
  const DB = createFakeDb({
    first: [current],
    all: [{ results: [
      { id: 'm-keep', normalized_text: 'deploy', marked_term_id: 't-keep', word_id: null },
      { id: 'm-drop-pending', normalized_text: 'obsolete', marked_term_id: 't-drop', word_id: null },
      { id: 'm-drop-word', normalized_text: 'removed', marked_term_id: null, word_id: 'w1' }
    ] }]
  });
  const request = new Request('https://app/api/articles/a1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'New', body: 'Deploy remains.' })
  });
  const response = await handleArticlesApi(request, { DB }, '/api/articles/a1', 'u1');
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.removed_marking_ids, ['m-drop-pending', 'm-drop-word']);
  assert.equal(DB.calls.filter(call => /DELETE FROM article_markings/.test(call.sql)).length, 2);
  assert.equal(DB.calls.filter(call => /DELETE FROM marked_terms/.test(call.sql)).length, 1);
  assert.equal(DB.calls.some(call => /UPDATE article_progress/.test(call.sql)), false);
  assert.ok(DB.calls.every(call => call.bindings.includes('u1')));
});

test('editing with resetProgress zeroes the aggregate and deletes its events', async () => {
  const DB = createFakeDb({
    first: [{
      id: 'a1', title: 'Old', body: 'Body', author: 'A', source: 'S', notes: 'N',
      created_at: 10, updated_at: 10
    }],
    all: [{ results: [] }]
  });
  const request = new Request('https://app/api/articles/a1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Updated', body: 'Body', resetProgress: true })
  });
  const response = await handleArticlesApi(request, { DB }, '/api/articles/a1', 'u1');

  assert.equal(response.status, 200);
  assert.equal((await response.json()).reset_progress, true);
  const progressCall = DB.calls.find(call => /UPDATE article_progress/.test(call.sql));
  assert.match(progressCall.sql, /last_position_ratio = 0/);
  assert.deepEqual(progressCall.bindings.slice(1), ['a1', 'u1']);
  const eventsCall = DB.calls.find(call => /DELETE FROM article_progress_events/.test(call.sql));
  assert.deepEqual(eventsCall.bindings, ['a1', 'u1']);
  assert.equal(DB.batches.length, 1);
});

test('editing hides articles not owned by the user', async () => {
  const DB = createFakeDb({ first: [null] });
  const request = new Request('https://app/api/articles/a1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Updated', body: 'Body' })
  });
  const response = await handleArticlesApi(request, { DB }, '/api/articles/a1', 'u2');

  assert.equal(response.status, 404);
  assert.equal(DB.calls.length, 1);
  assert.deepEqual(DB.calls[0].bindings, ['a1', 'u2']);
});

test('editing rejects a null JSON payload', async () => {
  const DB = createFakeDb();
  const response = await handleArticlesApi(
    new Request('https://app/api/articles/a1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'null'
    }),
    { DB }, '/api/articles/a1', 'u1'
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'ARTICLE_REQUIRED_FIELDS');
  assert.equal(DB.calls.length, 0);
});

test('deleting an article removes only pending terms with no remaining sources', async () => {
  const DB = createFakeDb({
    first: [{ id: 'a1' }],
    all: [{ results: [{ marked_term_id: 't1' }, { marked_term_id: 't2' }] }]
  });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles/a1', { method: 'DELETE' }),
    { DB }, '/api/articles/a1', 'u1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(DB.batches.length, 1);
  assert.equal(DB.batches[0].length, 3);
  const deleteArticle = DB.calls.find(call => /^DELETE FROM articles/.test(call.sql));
  assert.deepEqual(deleteArticle.bindings, ['a1', 'u1']);
  const pendingDeletes = DB.calls.filter(call => /^DELETE FROM marked_terms/.test(call.sql));
  assert.equal(pendingDeletes.length, 2);
  assert.ok(pendingDeletes.every(call => /NOT EXISTS/.test(call.sql)));
  assert.deepEqual(pendingDeletes[0].bindings, ['t1', 'u1', 't1', 'u1']);
  assert.ok(DB.calls.every(call => call.bindings.includes('u1')));
});

test('deleting hides articles not owned by the user and performs no cleanup', async () => {
  const DB = createFakeDb({ first: [null] });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles/a1', { method: 'DELETE' }),
    { DB }, '/api/articles/a1', 'u2'
  );

  assert.equal(response.status, 404);
  assert.equal(DB.calls.length, 1);
  assert.equal(DB.batches.length, 0);
});

test('worker routes authenticated article requests to the article handler', async () => {
  const secret = 'long-test-secret';
  const token = await createSessionToken('u1', secret);
  const DB = createFakeDb({ all: [{ results: [] }] });
  const response = await worker.fetch(
    new Request('https://app/api/articles', {
      headers: { cookie: `session=${token}` }
    }),
    { DB, AUTH_SECRET: secret }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(DB.calls[0].bindings, ['u1']);
});
