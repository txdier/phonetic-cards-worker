import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createArticlesView } from '../public/articles-view.js';
import { renderInlineError, requestConfirmation, showToast } from '../public/lib/dom.js';
import { createWordsView } from '../public/words-view.js';

function installDom(url = 'http://local.test/#/words') {
  const dom = new JSDOM('<!doctype html><div id="pc-root"></div>', { url });
  const previous = new Map();
  const values = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    location: dom.window.location,
    history: dom.window.history,
    CSS: { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    alert: () => {},
    confirm: () => true,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }
  };
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    window: dom.window,
    root: dom.window.document.getElementById('pc-root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

function click(window, node) {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function acceptConfirmation(window) {
  click(window, window.document.querySelector('[data-action="confirm-dialog-confirm"]'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

test('inline errors are safe alerts and replace the prior message without stacking', () => {
  const env = installDom();
  try {
    const firstCleanup = renderInlineError(env.root, '<b>first</b>');
    const secondCleanup = renderInlineError(env.root, 'second');
    const errors = env.root.querySelectorAll('.pc-inline-error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].getAttribute('role'), 'alert');
    assert.equal(errors[0].textContent, 'second');
    assert.equal(env.root.querySelector('b'), null);
    firstCleanup();
    assert.equal(env.root.querySelector('.pc-inline-error').textContent, 'second');
    secondCleanup();
    assert.equal(env.root.querySelector('.pc-inline-error'), null);
  } finally {
    env.restore();
  }
});

test('confirmation dialog resolves from buttons and restores focus', async () => {
  const env = installDom();
  try {
    const trigger = env.window.document.createElement('button');
    env.root.append(trigger);
    trigger.focus();
    const result = requestConfirmation({
      title: '删除文章', message: '删除后无法撤销。', confirmLabel: '删除', danger: true
    });
    const dialog = env.root.querySelector('[data-role="confirm-dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.querySelector('[data-action="confirm-dialog-confirm"]').classList.contains('pc-btn-danger'), true);
    click(env.window, dialog.querySelector('[data-action="confirm-dialog-cancel"]'));
    assert.equal(await result, false);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    env.restore();
  }
});

test('a confirmation removed by route rendering settles and releases its listener', async () => {
  const env = installDom();
  try {
    const first = requestConfirmation({ message: 'first' });
    env.root.querySelector('[data-role="confirm-backdrop"]').remove();
    const firstResult = await Promise.race([
      first,
      new Promise(resolve => setTimeout(() => resolve('unresolved'), 10))
    ]);
    assert.equal(firstResult, false);
    const second = requestConfirmation({ message: 'second' });
    click(env.window, env.root.querySelector('[data-action="confirm-dialog-cancel"]'));
    assert.equal(await second, false);
  } finally {
    env.restore();
  }
});

test('toast exposes an action and reports whether it timed out', async () => {
  const env = installDom();
  try {
    const actionToast = showToast({ message: '已删除', actionLabel: '撤销', duration: 1000 });
    click(env.window, env.root.querySelector('[data-action="toast-action"]'));
    assert.equal(await actionToast.closed, 'action');

    const timeoutToast = showToast({ message: '提示', duration: 0 });
    assert.equal(await timeoutToast.closed, 'timeout');
  } finally {
    env.restore();
  }
});

test('words view wires modes, speech, keyboard reveal, judging, and cleanup', async () => {
  const env = installDom();
  const calls = [];
  const spoken = [];
  let stopped = 0;
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/words') return [{
      id: 'w1', lemma: 'deploy', en: 'deployed', zh: '部署', example: 'We deployed it.',
      stress: 'de-PLOY', familiarity: 1, created_at: 10, forms: [{ form: 'deployed' }]
    }];
    return {};
  };
  const cleanup = createWordsView({
    root: env.root,
    api,
    speech: { isSupported: true, speakOnce: (...args) => spoken.push(args), stop: () => { stopped += 1; } }
  });
  try {
    await flush();
    assert.equal(env.root.querySelector('.pc-word').textContent, 'deploy');

    click(env.window, [...env.root.querySelectorAll('[data-action="mode"]')]
      .find(button => button.dataset.mode === 'test'));
    const testCard = env.root.querySelector('[data-action="reveal"]');
    assert.ok(testCard);

    const play = testCard.querySelector('[data-action="play"]');
    play.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(env.root.querySelector('.pc-reveal'), null);

    testCard.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok(env.root.querySelector('.pc-reveal'));

    const slow = env.root.querySelector('[data-action="slow"]');
    slow.checked = true;
    slow.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="play"]'));
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0][1].rate, 0.5);

    click(env.window, env.root.querySelector('[data-action="judge"][data-ok="1"]'));
    await flush();
    const patch = calls.find(call => call.init.method === 'PATCH');
    assert.deepEqual(JSON.parse(patch.init.body), { familiarity: 2 });

    const rerenderedCard = env.root.querySelector('[data-action="reveal"]');
    rerenderedCard.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.ok(env.root.querySelector('.pc-reveal'));

    click(env.window, [...env.root.querySelectorAll('[data-action="mode"]')]
      .find(button => button.dataset.mode === 'learn'));
    cleanup();
    click(env.window, [...env.root.querySelectorAll('[data-action="mode"]')]
      .find(button => button.dataset.mode === 'test'));
    assert.equal(env.root.querySelector('.pc-tab.active').dataset.mode, 'learn');
    assert.equal(stopped, 1);
  } finally {
    env.restore();
  }
});

test('judging a max-familiarity word moves it behind an equally familiar never-tested word', async () => {
  const env = installDom();
  const calls = [];
  const cleanup = createWordsView({
    root: env.root,
    api: async (path, init = {}) => {
      calls.push({ path, init });
      if (path === '/api/words' && !init.method) return [
        { id: 'old', lemma: 'old', en: 'old', zh: '先测试', familiarity: 4, last_tested_at: null, created_at: 1, forms: [] },
        { id: 'next', lemma: 'next', en: 'next', zh: '后测试', familiarity: 4, last_tested_at: null, created_at: 2, forms: [] }
      ];
      if (path === '/api/words/old' && init.method === 'PATCH') {
        return { ok: true, last_tested_at: 1234 };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    click(env.window, [...env.root.querySelectorAll('[data-action="mode"]')]
      .find(button => button.dataset.mode === 'test'));
    env.root.querySelector('[data-action="reveal"]')
      .dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="judge"][data-ok="1"]'));
    await flush();
    assert.match(env.root.querySelector('.pc-testcard').textContent, /后测试/);
    assert.ok(calls.some(call => call.path === '/api/words/old' && call.init.method === 'PATCH'));
  } finally {
    cleanup();
    env.restore();
  }
});

test('word cards expose an accessible edit form and retain learning metadata after save', async () => {
  const env = installDom();
  const calls = [];
  const initial = {
    id: 'w1', lemma: 'deploy', en: 'deploy', zh: '部署', example: 'Deploy it.', stress: 'de-PLOY',
    familiarity: 3, last_tested_at: 99, created_at: 1, forms: [{ form: 'deployed', normalized_form: 'deployed' }]
  };
  const cleanup = createWordsView({
    root: env.root,
    api: async (path, init = {}) => {
      calls.push({ path, init });
      if (path === '/api/words' && !init.method) return [initial];
      if (path === '/api/words/w1' && init.method === 'PATCH') {
        return { id: 'w1', en: 'launch', lemma: 'launch', zh: '启动', example: 'Launch it.', stress: 'LAUNCH' };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    const edit = env.root.querySelector('[data-id="w1"] [data-action="edit"]');
    assert.ok(edit);
    assert.equal(edit.getAttribute('aria-label'), '编辑 deploy');
    assert.equal(edit.textContent.trim(), '');
    assert.equal(edit.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    click(env.window, edit);
    const form = env.root.querySelector('#pc-word-form');
    assert.equal(form.classList.contains('open'), true);
    assert.match(form.querySelector('[data-role="word-form-title"]').textContent, /编辑单词/);
    assert.equal(form.querySelector('#f-en').value, 'deploy');
    assert.equal(form.querySelector('#f-zh').value, '部署');

    form.querySelector('#f-en').value = 'launch';
    form.querySelector('#f-zh').value = '启动';
    form.querySelector('#f-stress').value = 'LAUNCH';
    form.querySelector('#f-example').value = 'Launch it.';
    click(env.window, form.querySelector('[data-action="submit-form"]'));
    await flush();

    const patchCall = calls.find(call => call.path === '/api/words/w1' && call.init.method === 'PATCH');
    assert.deepEqual(JSON.parse(patchCall.init.body), {
      lemma: 'launch', zh: '启动', stress: 'LAUNCH', example: 'Launch it.'
    });
    assert.match(env.root.querySelector('[data-id="w1"]').textContent, /launch/);
    assert.match(env.root.querySelector('[data-id="w1"]').textContent, /启动/);
    assert.equal(initial.familiarity, 3);
    assert.equal(initial.last_tested_at, 99);
  } finally {
    cleanup();
    env.restore();
  }
});

test('words view uses inline errors and supports undo before delayed deletion', async () => {
  const env = installDom();
  const calls = [];
  const initial = {
    id: 'w1', lemma: 'keep', en: 'keep', zh: '保留', example: '', stress: '',
    familiarity: 0, created_at: 1, forms: []
  };
  const created = {
    id: 'w2', lemma: 'added', en: 'added', zh: '新增', example: '', stress: '',
    familiarity: 0, created_at: 2, forms: []
  };
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/words' && !init.method) return [initial];
    if (path === '/api/words' && init.method === 'POST') return created;
    return {};
  };
  const cleanup = createWordsView({
    root: env.root, api, deleteUndoMs: 10,
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="toggle-form"]'));
    click(env.window, env.root.querySelector('[data-action="submit-form"]'));
    assert.match(env.root.querySelector('#pc-word-form [data-inline-error]').textContent, /单词和中文含义/);

    env.root.querySelector('#f-en').value = 'added';
    env.root.querySelector('#f-zh').value = '新增';
    click(env.window, env.root.querySelector('[data-action="submit-form"]'));
    await flush();
    assert.match(env.root.textContent, /added/);
    assert.ok(calls.some(call => call.init.method === 'POST'));

    click(env.window, env.root.querySelector('[data-action="del"][data-id="w2"]'));
    assert.equal(env.root.querySelector('[data-id="w2"]'), null);
    assert.equal(calls.some(call => call.path === '/api/words/w2' && call.init.method === 'DELETE'), false);
    click(env.window, env.root.querySelector('[data-action="toast-action"]'));
    await flush();
    assert.ok(env.root.querySelector('[data-id="w2"]'));
    assert.equal(calls.some(call => call.path === '/api/words/w2' && call.init.method === 'DELETE'), false);

    click(env.window, env.root.querySelector('[data-action="del"][data-id="w2"]'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(calls.some(call => call.path === '/api/words/w2' && call.init.method === 'DELETE'));
  } finally {
    cleanup();
    env.restore();
  }
});

test('words view retains failed additions and restores failed delayed deletions', async () => {
  const env = installDom();
  const word = {
    id: 'w1', lemma: 'keep', en: 'keep', zh: '保留', example: '', stress: '',
    familiarity: 0, created_at: 1, forms: []
  };
  const cleanup = createWordsView({
    root: env.root,
    deleteUndoMs: 0,
    api: async (path, init = {}) => {
      if (path === '/api/words' && !init.method) return [word];
      if (path === '/api/words' && init.method === 'POST') throw new Error('新增失败');
      if (path === '/api/words/w1' && init.method === 'DELETE') throw new Error('删除失败');
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="toggle-form"]'));
    env.root.querySelector('#f-en').value = 'failed';
    env.root.querySelector('#f-zh').value = '失败';
    click(env.window, env.root.querySelector('[data-action="submit-form"]'));
    await flush();
    const form = env.root.querySelector('#pc-word-form');
    assert.equal(form.classList.contains('open'), true);
    assert.equal(form.querySelector('[data-inline-error]').textContent, '新增失败');
    assert.equal(form.querySelector('#f-en').value, 'failed');

    click(env.window, env.root.querySelector('[data-action="cancel-form"]'));
    click(env.window, env.root.querySelector('[data-action="del"][data-id="w1"]'));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(env.root.querySelector('[data-id="w1"]'));
    assert.equal(env.root.querySelector(':scope > [data-inline-error]').textContent, '删除失败');
  } finally {
    cleanup();
    env.restore();
  }
});

test('words view disables pronunciation with an explanation when speech is unavailable', async () => {
  const env = installDom();
  const cleanup = createWordsView({
    root: env.root,
    api: async () => [{ id: 'w1', lemma: 'safe', en: 'safe', zh: '安全', example: '', stress: '', familiarity: 0, created_at: 1, forms: [] }],
    speech: { isSupported: false, speakOnce() { throw new Error('must stay disabled'); }, stop() {} }
  });
  try {
    await flush();
    assert.equal(env.root.querySelector('[data-action="play"]').disabled, true);
    assert.equal(env.root.querySelector('[data-action="slow"]').disabled, true);
    assert.match(env.root.querySelector('[data-role="speech-unavailable"]').textContent, /浏览器.*语音/);
  } finally {
    cleanup();
    env.restore();
  }
});

test('articles view wires create, failed value retention, edit reset, delete success, and cleanup', async () => {
  const env = installDom('http://local.test/#/articles/library');
  const calls = [];
  let createAttempts = 0;
  let deleteAttempts = 0;
  const existing = {
    id: 'a1', title: 'Existing', author: '', source: '', notes: '', created_at: 1,
    progress: { last_position_ratio: 0.7, completed: true, read_count: 3, active_read_ms: 40, full_read_aloud_count: 1, updated_at: 1 }
  };
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/articles' && !init.method) return [existing];
    if (path === '/api/articles' && init.method === 'POST') {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('create failed');
      return { id: 'a2', ...JSON.parse(init.body), created_at: 2, progress: { last_position_ratio: 0 } };
    }
    if (path === '/api/articles/a1' && !init.method) {
      return { ...existing, body: 'Original body' };
    }
    if (path === '/api/articles/a1' && init.method === 'PATCH') {
      return { id: 'a1', ...JSON.parse(init.body), updated_at: 20 };
    }
    if (path === '/api/articles/a1' && init.method === 'DELETE') {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error('delete failed');
      return { ok: true };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createArticlesView({
    root: env.root, api, route: { module: 'articles', page: 'library' }, navigate() {}
  });
  try {
    await flush();
    assert.equal(env.root.querySelector('[data-id="a1"] .pc-article-title').textContent, 'Existing');

    click(env.window, env.root.querySelector('[data-action="new"]'));
    const createForm = env.root.querySelector('[data-role="article-form"]');
    createForm.elements.title.value = 'Retained title';
    createForm.elements.body.value = 'Retained body';
    submit(env.window, createForm);
    await flush();
    assert.equal(createForm.elements.title.value, 'Retained title');
    assert.equal(createForm.elements.body.value, 'Retained body');
    assert.equal(createForm.querySelector('[data-role="form-error"]').textContent, 'create failed');
    assert.equal(createForm.querySelectorAll('[role="alert"][data-role="form-error"]').length, 1);

    submit(env.window, createForm);
    await flush();
    assert.equal(env.root.querySelector('[data-id="a2"] .pc-article-title').textContent, 'Retained title');

    const existingCard = env.root.querySelector('[data-id="a1"]');
    click(env.window, existingCard.querySelector('[data-action="edit"]'));
    await flush();
    const editForm = env.root.querySelector('[data-role="article-form"]');
    editForm.elements.title.value = 'Edited';
    submit(env.window, editForm);
    acceptConfirmation(env.window);
    await flush();
    const patchCall = calls.find(call => call.path === '/api/articles/a1' && call.init.method === 'PATCH');
    assert.equal(JSON.parse(patchCall.init.body).resetProgress, true);
    const editedCard = env.root.querySelector('[data-id="a1"]');
    assert.equal(editedCard.querySelector('.pc-article-title').textContent, 'Edited');
    assert.match(editedCard.textContent, /未开始/);

    click(env.window, editedCard.querySelector('[data-action="delete"]'));
    acceptConfirmation(env.window);
    await flush();
    assert.ok(env.root.querySelector('[data-id="a1"]'));
    assert.equal(env.root.querySelector('[data-role="page-error"]').textContent, 'delete failed');
    click(env.window, env.root.querySelector('[data-id="a1"] [data-action="delete"]'));
    acceptConfirmation(env.window);
    await flush();
    assert.equal(env.root.querySelector('[data-id="a1"]'), null);
    assert.equal(env.root.querySelector('[data-role="page-error"]'), null);

    cleanup();
    click(env.window, env.root.querySelector('[data-action="new"]'));
    assert.equal(env.root.querySelector('[data-role="article-form"]'), null);
  } finally {
    env.restore();
  }
});

test('article save disables cancel and ignores a deferred failure after unmount', async () => {
  const env = installDom('http://local.test/#/articles/library');
  const save = deferred();
  const cleanup = createArticlesView({
    root: env.root,
    api: async (path, init = {}) => {
      if (path === '/api/articles' && !init.method) return [];
      if (path === '/api/articles' && init.method === 'POST') return save.promise;
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    route: { module: 'articles', page: 'library' }, navigate() {}
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="new"]'));
    const form = env.root.querySelector('[data-role="article-form"]');
    form.elements.title.value = 'Deferred';
    form.elements.body.value = 'Body';
    submit(env.window, form);
    const cancel = form.querySelector('[data-action="cancel-form"]');
    assert.equal(cancel.disabled, true);
    click(env.window, cancel);
    assert.ok(env.root.querySelector('[data-role="article-form"]'));
    cleanup();
    save.reject(new Error('late failure'));
    await flush();
    assert.equal(form.querySelector('[data-role="form-error"]'), null);
  } finally {
    env.restore();
  }
});

test('article edit and delete ignore deferred results after unmount', async () => {
  const existing = { id: 'a1', title: 'Existing', created_at: 1, progress: { last_position_ratio: 0 } };
  for (const action of ['edit', 'delete']) {
    const env = installDom('http://local.test/#/articles/library');
    const request = deferred();
    const cleanup = createArticlesView({
      root: env.root,
      api: async (path, init = {}) => {
        if (path === '/api/articles' && !init.method) return [existing];
        if (path === '/api/articles/a1') return request.promise;
        throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
      },
      route: { module: 'articles', page: 'library' }, navigate() {}
    });
    try {
      await flush();
      click(env.window, env.root.querySelector(`[data-action="${action}"]`));
      cleanup();
      request.resolve(action === 'edit' ? { ...existing, body: 'Body' } : { ok: true });
      await flush();
      assert.equal(env.root.querySelector('[data-role="article-form"]'), null);
      assert.ok(env.root.querySelector('[data-id="a1"]'));
    } finally {
      env.restore();
    }
  }
});

test('article edit ignores a deferred failure after unmount', async () => {
  const env = installDom('http://local.test/#/articles/library');
  const detail = deferred();
  const existing = { id: 'a1', title: 'Existing', created_at: 1, progress: { last_position_ratio: 0 } };
  const cleanup = createArticlesView({
    root: env.root,
    api: async path => path === '/api/articles' ? [existing] : detail.promise,
    route: { module: 'articles', page: 'library' }, navigate() {}
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="edit"]'));
    cleanup();
    detail.reject(new Error('late edit failure'));
    await flush();
    assert.equal(env.root.querySelector('[data-role="page-error"]'), null);
  } finally {
    env.restore();
  }
});

test('article edit response cannot reopen an article deleted while detail was loading', async () => {
  const env = installDom('http://local.test/#/articles/library');
  const detail = deferred();
  const existing = { id: 'a1', title: 'Existing', created_at: 1, progress: { last_position_ratio: 0 } };
  const cleanup = createArticlesView({
    root: env.root,
    api: async (path, init = {}) => {
      if (path === '/api/articles' && !init.method) return [existing];
      if (path === '/api/articles/a1' && !init.method) return detail.promise;
      if (path === '/api/articles/a1' && init.method === 'DELETE') return { ok: true };
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    route: { module: 'articles', page: 'library' }, navigate() {}
  });
  try {
    await flush();
    const card = env.root.querySelector('[data-id="a1"]');
    click(env.window, card.querySelector('[data-action="edit"]'));
    click(env.window, card.querySelector('[data-action="delete"]'));
    acceptConfirmation(env.window);
    await flush();
    detail.resolve({ ...existing, body: 'Body' });
    await flush();
    assert.equal(env.root.querySelector('[data-role="article-form"]'), null);
    assert.equal(env.root.querySelector('[data-id="a1"]'), null);
  } finally {
    cleanup();
    env.restore();
  }
});

test('latest article edit wins when an earlier detail response arrives last', async () => {
  const env = installDom('http://local.test/#/articles/library');
  const aDetail = deferred();
  const bDetail = deferred();
  const articles = [
    { id: 'a1', title: 'Article A', created_at: 1, progress: { last_position_ratio: 0 } },
    { id: 'b1', title: 'Article B', created_at: 2, progress: { last_position_ratio: 0 } }
  ];
  const cleanup = createArticlesView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles') return articles;
      if (path === '/api/articles/a1') return aDetail.promise;
      if (path === '/api/articles/b1') return bDetail.promise;
      throw new Error(`unexpected request GET ${path}`);
    },
    route: { module: 'articles', page: 'library' }, navigate() {}
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-id="a1"] [data-action="edit"]'));
    click(env.window, env.root.querySelector('[data-id="b1"] [data-action="edit"]'));
    bDetail.resolve({ ...articles[1], body: 'Body B' });
    await flush();
    assert.equal(env.root.querySelector('[data-role="article-form"]').elements.title.value, 'Article B');
    aDetail.resolve({ ...articles[0], body: 'Body A' });
    await flush();
    assert.equal(env.root.querySelector('[data-role="article-form"]').elements.title.value, 'Article B');
  } finally {
    cleanup();
    env.restore();
  }
});

test('stale article edit failure cannot replace the current edit form', async () => {
  const env = installDom('http://local.test/#/articles/library');
  const aDetail = deferred();
  const bDetail = deferred();
  const articles = [
    { id: 'a1', title: 'Article A', created_at: 1, progress: { last_position_ratio: 0 } },
    { id: 'b1', title: 'Article B', created_at: 2, progress: { last_position_ratio: 0 } }
  ];
  const cleanup = createArticlesView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles') return articles;
      if (path === '/api/articles/a1') return aDetail.promise;
      if (path === '/api/articles/b1') return bDetail.promise;
      throw new Error(`unexpected request GET ${path}`);
    },
    route: { module: 'articles', page: 'library' }, navigate() {}
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-id="a1"] [data-action="edit"]'));
    click(env.window, env.root.querySelector('[data-id="b1"] [data-action="edit"]'));
    bDetail.resolve({ ...articles[1], body: 'Body B' });
    await flush();
    aDetail.reject(new Error('stale A failure'));
    await flush();
    assert.equal(env.root.querySelector('[data-role="article-form"]').elements.title.value, 'Article B');
    assert.equal(env.root.querySelector('[data-role="page-error"]'), null);
  } finally {
    cleanup();
    env.restore();
  }
});

test('app coordinator replaces the authenticated shell with login after a real words 401', async () => {
  const env = installDom();
  env.window.localStorage.setItem('pc-progress-queue:joe', JSON.stringify([{
    kind: 'event', articleId: 'a1', event: { id: 'e1', type: 'read_complete', amount: 1 }
  }]));
  let progressRetries = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async path => {
    if (path === '/api/me') return new Response(JSON.stringify({ username: 'joe' }), { status: 200 });
    if (path === '/api/words') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    if (path === '/api/articles/a1/progress/events') {
      progressRetries += 1;
      return new Response(JSON.stringify({ error: 'offline' }), { status: 503 });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    await import(`../public/app.js?dom-test=${Date.now()}`);
    await flush();
    assert.ok(env.root.querySelector('.pc-login-card'));
    assert.equal(env.root.querySelector('.pc-app-shell'), null);
    assert.equal(progressRetries, 1);
    env.window.dispatchEvent(new env.window.Event('online'));
    await flush();
    assert.equal(progressRetries, 1);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});
