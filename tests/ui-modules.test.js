import test from 'node:test';
import assert from 'node:assert/strict';

test('api returns JSON success, preserves headers, and adds content type only with a body', async () => {
  const { api } = await import('../public/api.js');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    assert.deepEqual(await api('/get', { headers: { 'x-request': 'one' } }), { ok: true });
    await api('/post', {
      method: 'POST', body: '{}', headers: { 'x-request': 'two', 'content-type': 'application/custom' }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(new Headers(calls[0].init.headers).get('x-request'), 'one');
  assert.equal(new Headers(calls[0].init.headers).has('content-type'), false);
  assert.equal(new Headers(calls[1].init.headers).get('x-request'), 'two');
  assert.equal(new Headers(calls[1].init.headers).get('content-type'), 'application/custom');
});

test('api exposes JSON and text errors without swallowing them', async () => {
  const { api, ApiError } = await import('../public/api.js');
  const originalFetch = globalThis.fetch;
  let response = new Response(JSON.stringify({ error: 'invalid', code: 'INVALID' }), { status: 400 });
  globalThis.fetch = async () => response;
  try {
    await assert.rejects(api('/json'), error =>
      error instanceof ApiError && error.status === 400 && error.code === 'INVALID' && error.message === 'invalid'
    );
    response = new Response('gateway unavailable', { status: 502 });
    await assert.rejects(api('/text'), error =>
      error instanceof ApiError && error.status === 502 && error.message === 'gateway unavailable'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api notifies the app coordinator and still propagates a 401', async () => {
  const { api, ApiError, setUnauthorizedHandler } = await import('../public/api.js');
  const originalFetch = globalThis.fetch;
  let currentView = 'words';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  setUnauthorizedHandler(() => { currentView = 'login'; });
  try {
    await assert.rejects(api('/api/words'), error => error instanceof ApiError && error.status === 401);
  } finally {
    setUnauthorizedHandler(null);
    globalThis.fetch = originalFetch;
  }
  assert.equal(currentView, 'login');
});

test('article reader routes round-trip ids by decoding individual path segments', async () => {
  const { hashForRoute, parseHashRoute } = await import('../public/routes.js');
  const route = { module: 'articles', page: 'reader', id: 'a/b' };
  assert.deepEqual(parseHashRoute(hashForRoute(route)), route);
  assert.deepEqual(parseHashRoute('#/unknown/place'), { module: 'words', page: 'library' });
});

test('word test helpers sort without mutation and calculate judge state', async () => {
  const { sortWordTestQueue, nextFamiliarity } = await import('../public/words-view.js');
  const words = [
    { id: 'recently-tested', familiarity: 2, last_tested_at: 30, created_at: 5 },
    { id: 'due', familiarity: 0, last_tested_at: 40, created_at: 10 },
    { id: 'never-tested-new', familiarity: 2, last_tested_at: null, created_at: 20 },
    { id: 'never-tested-old', familiarity: 2, last_tested_at: null, created_at: 5 },
    { id: 'least-recently-tested', familiarity: 2, last_tested_at: 10, created_at: 30 }
  ];
  assert.deepEqual(sortWordTestQueue(words).map(word => word.id), [
    'due', 'never-tested-old', 'never-tested-new', 'least-recently-tested', 'recently-tested'
  ]);
  assert.deepEqual(words.map(word => word.id), [
    'recently-tested', 'due', 'never-tested-new', 'never-tested-old', 'least-recently-tested'
  ]);
  assert.equal(nextFamiliarity(4, true), 4);
  assert.equal(nextFamiliarity(2, true), 3);
  assert.equal(nextFamiliarity(3, false), 2);
  assert.equal(nextFamiliarity(0, false), 0);
});

test('word reveal keyboard contract accepts Enter and Space only', async () => {
  const { isRevealKey, shouldRevealTestCard } = await import('../public/words-view.js');
  assert.equal(isRevealKey('Enter'), true);
  assert.equal(isRevealKey(' '), true);
  assert.equal(isRevealKey('Escape'), false);
  assert.equal(shouldRevealTestCard('Enter'), true);
  assert.equal(shouldRevealTestCard(' ', 'play'), false);
  assert.equal(shouldRevealTestCard('Enter', 'judge'), false);
});

test('successful edited article reset clears local progress without mutating prior state', async () => {
  const { updateArticlesAfterSave } = await import('../public/articles-view.js');
  const original = [{
    id: 'a1', title: 'Old', progress: {
      last_position_ratio: 0.75, completed: true, read_count: 4,
      active_read_ms: 5000, full_read_aloud_count: 2, updated_at: 10
    }
  }];
  const before = structuredClone(original);
  const next = updateArticlesAfterSave(original, {
    editingId: 'a1', resetProgress: true, saved: { id: 'a1', title: 'Edited', updated_at: 20 }
  });
  assert.deepEqual(original, before);
  assert.equal(next[0].title, 'Edited');
  assert.deepEqual(next[0].progress, {
    last_position_ratio: 0, completed: false, read_count: 0,
    active_read_ms: 0, full_read_aloud_count: 0, updated_at: 20
  });
});

test('article save state preserves progress and failed outcomes preserve the list', async () => {
  const { updateArticlesAfterSave } = await import('../public/articles-view.js');
  const articles = [{ id: 'a1', title: 'Old', progress: { last_position_ratio: 0.5 } }];
  const preserved = updateArticlesAfterSave(articles, {
    editingId: 'a1', resetProgress: false, saved: { id: 'a1', title: 'Edited' }
  });
  assert.deepEqual(preserved[0].progress, { last_position_ratio: 0.5 });
  assert.equal(updateArticlesAfterSave(articles, { editingId: 'a1', saved: null }), articles);
});
