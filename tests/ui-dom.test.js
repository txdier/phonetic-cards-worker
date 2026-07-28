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

test('review view reveals cards, submits one of four FSRS ratings, and cleans up', async () => {
  const env = installDom();
  const calls = [];
  const spoken = [];
  let stopped = 0;
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/reviews/due?limit=20') return { words: [{
      id: 'w1', lemma: 'deploy', en: 'deployed', zh: '部署', example: 'We deployed it.',
      stress: 'de-PLOY', state: 0, due_at: 0, created_at: 10, forms: [{ form: 'deployed' }]
    }] };
    if (path === '/api/words/w1/reviews') return { ok: true };
    return {};
  };
  const cleanup = createWordsView({
    root: env.root,
    api,
    page: 'review',
    speech: { isSupported: true, getRate: () => 1, speakOnce: (...args) => spoken.push(args), stop: () => { stopped += 1; } }
  });
  try {
    await flush();
    const testCard = env.root.querySelector('[data-action="reveal"]');
    assert.ok(testCard);

    const play = testCard.querySelector('[data-action="play"]');
    play.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(env.root.querySelector('.pc-reveal'), null);

    testCard.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok(env.root.querySelector('.pc-reveal'));
    click(env.window, env.root.querySelector('[data-action="play"]'));
    assert.equal(spoken.length, 1);
    assert.equal(env.root.querySelectorAll('[data-action="judge"]').length, 4);
    click(env.window, env.root.querySelector('[data-action="judge"][data-rating="3"]'));
    await flush();
    const reviewCall = calls.find(call => call.path === '/api/words/w1/reviews');
    assert.equal(JSON.parse(reviewCall.init.body).rating, 3);
    assert.match(env.root.textContent, /没有到期词卡/);
    cleanup();
    assert.equal(stopped, 1);
  } finally {
    env.restore();
  }
});

test('review view orders due cards without mutating the response', async () => {
  const env = installDom();
  const source = [
    { id: 'later', lemma: 'later', zh: '后', due_at: 20, created_at: 1, forms: [] },
    { id: 'first', lemma: 'first', zh: '先', due_at: 10, created_at: 2, forms: [] }
  ];
  const cleanup = createWordsView({
    root: env.root,
    page: 'review',
    api: async path => path === '/api/reviews/due?limit=20' ? { words: source } : {},
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    assert.match(env.root.querySelector('.pc-testcard').textContent, /先/);
    assert.deepEqual(source.map(word => word.id), ['later', 'first']);
  } finally {
    cleanup();
    env.restore();
  }
});

test('review retry reuses its id after an ambiguous transport failure', async () => {
  const env = installDom();
  const payloads = [];
  let attempts = 0;
  const cleanup = createWordsView({
    root: env.root,
    page: 'review',
    api: async (path, init = {}) => {
      if (path === '/api/reviews/due?limit=20') {
        return { words: [{ id: 'w1', lemma: 'retry', zh: '重试', due_at: 0, version: 2, forms: [] }] };
      }
      payloads.push(JSON.parse(init.body));
      attempts += 1;
      if (attempts === 1) throw new Error('connection lost');
      return { ok: true };
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="reveal"]'));
    click(env.window, env.root.querySelector('[data-action="judge"][data-rating="3"]'));
    await flush();
    assert.equal(env.root.querySelector('[data-action="judge"][data-rating="4"]').disabled, true);
    click(env.window, env.root.querySelector('[data-action="judge"][data-rating="3"]'));
    await flush();
    assert.equal(payloads[0].reviewId, payloads[1].reviewId);
    assert.equal(payloads[1].version, 2);
  } finally {
    cleanup();
    env.restore();
  }
});

test('word cards expose an accessible edit form and retain FSRS metadata after save', async () => {
  const env = installDom();
  const calls = [];
  const initial = {
    id: 'w1', lemma: 'deploy', en: 'deploy', zh: '部署', example: 'Deploy it.', stress: 'de-PLOY',
    state: 2, reps: 3, due_at: 99, created_at: 1, tags: [],
    forms: [{ form: 'deployed', normalized_form: 'deployed' }]
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
    assert.ok(edit.querySelector('svg'));
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
      lemma: 'launch', en: 'launch', zh: '启动', stress: 'LAUNCH',
      example: 'Launch it.', tagIds: []
    });
    assert.match(env.root.querySelector('[data-id="w1"]').textContent, /launch/);
    assert.match(env.root.querySelector('[data-id="w1"]').textContent, /启动/);
    assert.equal(initial.state, 2);
    assert.equal(initial.due_at, 99);
  } finally {
    cleanup();
    env.restore();
  }
});

test('word cards reserve icon actions and wrap phrases without wrapping ordinary words', async () => {
  const env = installDom();
  const words = [
    { id: 'w1', lemma: 'make progress', zh: '取得进展', forms: [], tags: [] },
    { id: 'w2', lemma: 'infrastructure', zh: '基础设施', forms: [], tags: [] },
    { id: 'w3', lemma: 'counterrevolutionaries', zh: '反革命者', forms: [], tags: [] }
  ];
  const cleanup = createWordsView({
    root: env.root,
    api: async path => {
      if (path === '/api/words') return words;
      if (path === '/api/tags') return { tags: [] };
      throw new Error(`unexpected request GET ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    const phrase = env.root.querySelector('[data-id="w1"] .pc-word');
    const longWord = env.root.querySelector('[data-id="w2"] .pc-word');
    const extraLongWord = env.root.querySelector('[data-id="w3"] .pc-word');
    assert.ok(phrase.classList.contains('pc-word-phrase'));
    assert.ok(longWord.classList.contains('pc-word-long'));
    assert.ok(extraLongWord.classList.contains('pc-word-extra-long'));
    assert.equal(extraLongWord.title, 'counterrevolutionaries');

    const card = env.root.querySelector('[data-id="w2"]');
    const actions = [...card.querySelectorAll('.pc-card-top-actions > button')];
    assert.deepEqual(actions.map(button => button.dataset.action), ['edit', 'toggle-card-menu']);
    assert.ok(actions.every(button => button.querySelector('svg')));
    assert.equal(actions[1].getAttribute('aria-haspopup'), 'menu');
    assert.equal(actions[1].getAttribute('aria-expanded'), 'false');
  } finally {
    cleanup();
    env.restore();
  }
});

test('word card more menu supports keyboard navigation and restores focus', async () => {
  const env = installDom();
  const word = { id: 'w1', lemma: 'deploy', zh: '部署', forms: [], tags: [] };
  const cleanup = createWordsView({
    root: env.root,
    api: async path => {
      if (path === '/api/words') return [word];
      if (path === '/api/tags') return { tags: [] };
      throw new Error(`unexpected request GET ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    const toggle = env.root.querySelector('[data-action="toggle-card-menu"]');
    click(env.window, toggle);
    const menu = env.root.querySelector('[data-role="card-action-menu"]');
    assert.ok(menu);
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map(item => item.dataset.action), ['open-relations', 'del']);
    assert.equal(env.window.document.activeElement, items[0]);

    items[0].dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'ArrowDown', bubbles: true, cancelable: true
    }));
    assert.equal(env.window.document.activeElement, items[1]);
    items[1].dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.querySelector('[data-role="card-action-menu"]'), null);
    assert.equal(env.window.document.activeElement, toggle);

    click(env.window, toggle);
    env.window.document.body.dispatchEvent(new env.window.Event('pointerdown', {
      bubbles: true, cancelable: true
    }));
    assert.equal(env.root.querySelector('[data-role="card-action-menu"]'), null);
  } finally {
    cleanup();
    env.restore();
  }
});

test('word relations open in a modal and update without stretching the card', async () => {
  const env = installDom();
  const calls = [];
  const word = { id: 'w1', lemma: 'deploy', zh: '部署', forms: [], tags: [] };
  let relations = [{
    id: 'r1', target_word_id: 'w2', target_lemma: 'deployment',
    relation_type: 'derivative', note: 'noun'
  }];
  const cleanup = createWordsView({
    root: env.root,
    api: async (path, init = {}) => {
      calls.push({ path, init });
      if (path === '/api/words' && !init.method) return [word];
      if (path === '/api/tags' && !init.method) return { tags: [] };
      if (path === '/api/words/w1/relations' && !init.method) return { relations };
      if (path === '/api/words?pageSize=100&sort=word' && !init.method) {
        return { words: [word, { id: 'w2', lemma: 'deployment', zh: '部署行为' }] };
      }
      if (path === '/api/words/w1/relations' && init.method === 'POST') {
        relations = [...relations, {
          id: 'r2', target_word_id: 'w2', target_lemma: 'deployment',
          relation_type: 'family', note: ''
        }];
        return { relation: relations.at(-1) };
      }
      if (path === '/api/words/w1/relations/r1' && init.method === 'DELETE') {
        relations = relations.filter(item => item.id !== 'r1');
        return { ok: true };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    const toggle = env.root.querySelector('[data-action="toggle-card-menu"]');
    click(env.window, toggle);
    click(env.window, env.root.querySelector('[data-action="open-relations"]'));
    const dialog = env.root.querySelector('[data-role="relation-dialog"]');
    assert.ok(dialog);
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.match(dialog.querySelector('.pc-dialog-title').textContent, /deploy 的词间关系/);
    await flush();
    assert.equal(env.root.querySelector('.pc-card .pc-relation-panel'), null);
    assert.match(dialog.textContent, /deployment/);
    assert.match(dialog.textContent, /派生/);

    const sections = dialog.querySelectorAll('.pc-relation-section');
    assert.equal(sections.length, 2);
    assert.ok(dialog.querySelector('.pc-relation-search-field input[name="targetKeyword"]'));
    assert.ok(dialog.querySelector('.pc-relation-search-field [data-action="search-relation-targets"]'));
    assert.equal(dialog.querySelectorAll('.pc-relation-pair label').length, 2);
    assert.ok(dialog.querySelector('.pc-relation-note input[name="note"]'));
    assert.ok(dialog.querySelector('.pc-relation-form-actions .pc-btn-primary'));
    assert.ok(dialog.querySelector('.pc-relation-delete[data-action="delete-relation"]'));

    const form = dialog.querySelector('[data-role="relation-form"]');
    form.elements.relationType.value = 'family';
    submit(env.window, form);
    await flush();
    assert.ok(calls.some(call => call.path === '/api/words/w1/relations' && call.init.method === 'POST'));
    assert.ok(env.root.querySelector('[data-role="relation-dialog"]'));

    click(env.window, env.root.querySelector('[data-action="delete-relation"][data-id="r1"]'));
    await flush();
    assert.ok(calls.some(call => call.path === '/api/words/w1/relations/r1' && call.init.method === 'DELETE'));
    assert.ok(env.root.querySelector('[data-role="relation-dialog"]'));

    click(env.window, env.root.querySelector('[data-action="close-relations"]'));
    assert.equal(env.root.querySelector('[data-role="relation-dialog"]'), null);
    assert.equal(env.window.document.activeElement, toggle);
  } finally {
    cleanup();
    env.restore();
  }
});

test('relation dialog reports a load failure, retries, and ignores a late close', async () => {
  const env = installDom();
  const lateRelations = deferred();
  const word = { id: 'w1', lemma: 'deploy', zh: '部署', forms: [], tags: [] };
  let relationAttempts = 0;
  const cleanup = createWordsView({
    root: env.root,
    api: async path => {
      if (path === '/api/words') return [word];
      if (path === '/api/tags') return { tags: [] };
      if (path === '/api/words?pageSize=100&sort=word') return { words: [word] };
      if (path === '/api/words/w1/relations') {
        relationAttempts += 1;
        if (relationAttempts === 1) throw new Error('关系加载失败');
        return lateRelations.promise;
      }
      throw new Error(`unexpected request GET ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    const toggle = env.root.querySelector('[data-action="toggle-card-menu"]');
    click(env.window, toggle);
    click(env.window, env.root.querySelector('[data-action="open-relations"]'));
    await flush();
    assert.equal(
      env.root.querySelector('[data-role="relation-dialog-error"] span').textContent,
      '关系加载失败'
    );
    click(env.window, env.root.querySelector('[data-action="retry-relations"]'));
    assert.match(env.root.querySelector('[data-role="relation-dialog"]').textContent, /加载词间关系中/);
    click(env.window, env.root.querySelector('[data-action="close-relations"]'));
    lateRelations.resolve({ relations: [] });
    await flush();
    assert.equal(env.root.querySelector('[data-role="relation-dialog"]'), null);
    assert.equal(env.window.document.activeElement, toggle);
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

    click(env.window, env.root.querySelector('[data-id="w2"] [data-action="toggle-card-menu"]'));
    click(env.window, env.root.querySelector('[data-action="del"][data-id="w2"]'));
    assert.equal(env.root.querySelector('[data-id="w2"]'), null);
    assert.equal(calls.some(call => call.path === '/api/words/w2' && call.init.method === 'DELETE'), false);
    click(env.window, env.root.querySelector('[data-action="toast-action"]'));
    await flush();
    assert.ok(env.root.querySelector('[data-id="w2"]'));
    assert.equal(calls.some(call => call.path === '/api/words/w2' && call.init.method === 'DELETE'), false);

    click(env.window, env.root.querySelector('[data-id="w2"] [data-action="toggle-card-menu"]'));
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
    click(env.window, env.root.querySelector('[data-id="w1"] [data-action="toggle-card-menu"]'));
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
