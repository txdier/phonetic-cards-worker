import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createPendingView } from '../public/pending-view.js';
import { createReaderView } from '../public/reader-view.js';

function installDom(url = 'http://local.test/#/articles/reader/a1') {
  const dom = new JSDOM('<!doctype html><div id="pc-root"></div>', { url });
  dom.window.scrollTo = () => {};
  const previous = new Map();
  const values = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    confirm: () => true
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

function validSelection(sentence, { text = sentence.textContent, removeAllRanges = () => {} } = {}) {
  return {
    anchorNode: sentence.firstChild,
    focusNode: sentence.firstChild,
    isCollapsed: false,
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({ getBoundingClientRect: () => ({}) }),
    removeAllRanges
  };
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function articleDetail(overrides = {}) {
  return {
    id: 'a1', title: '<img src=x onerror=alert(1)>', body: 'Deployed safely. Select this phrase.\n\nAgain deploy.',
    author: '<b>Writer</b>', source: 'Unsafe & source', notes: '', created_at: 1, updated_at: 1,
    progress: { last_position_ratio: 0 },
    markings: [{
      id: 'm1', normalized_text: 'deploy', selected_text: 'deploy',
      context_sentence: 'Again deploy.', marked_term_id: 't1', word_id: null, created_at: 2
    }],
    pending_terms: [{
      id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', created_at: 2
    }],
    words: [{
      id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署；发布',
      example: 'They deployed.', stress: 'de-PLOY',
      forms: [{ id: 'f1', form: 'Deployed', normalized_form: 'deployed' }]
    }],
    ...overrides
  };
}

function createReaderSpeechFake(isSupported = true) {
  const calls = [];
  let listener = null;
  let rate = 1;
  let unsubscribed = 0;
  return {
    calls,
    controller: {
      isSupported,
      speakOnce(text) { calls.push(['speakOnce', text]); },
      load(sentences) { calls.push(['load', sentences]); },
      startAt(index) { calls.push(['startAt', index]); },
      pause() { calls.push(['pause']); },
      resume() { calls.push(['resume']); },
      stop() { calls.push(['stop']); },
      setRate(value) { rate = Number(value); calls.push(['setRate', rate]); return rate; },
      getRate() { return rate; },
      subscribe(next) {
        listener = next;
        next({ state: 'idle', currentIndex: null, completion: { reachedEnd: false, coverage: 0, counted: false } });
        return () => { unsubscribed += 1; listener = null; };
      }
    },
    emit(state) { listener?.(state); },
    get unsubscribed() { return unsubscribed; }
  };
}

function assertSharedReaderPopover(panel, word) {
  assert.ok(panel, `expected a popover for ${word}`);
  assert.equal(panel.querySelector('[data-role="reader-popover-word"]').textContent, word);
  assert.ok(panel.querySelector('[data-role="reader-popover-head"]'));
  assert.ok(panel.querySelector('[data-role="reader-popover-body"]'));
  assert.ok(panel.querySelector('[data-action^="close-"]'));
  assert.ok(panel.querySelector('[data-role="reader-popover-bookmark"]'));
  assert.deepEqual(
    [...panel.querySelectorAll('[data-role="reader-popover-tools"] button')].map(button => button.textContent.trim()),
    ['发音', '从本句开始全文朗读']
  );
}

test('selection suppresses the following collapsed sentence click', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    let selected = true;
    env.window.getSelection = () => selected ? validSelection(sentence, { text: 'Select this phrase' }) : {
      isCollapsed: true, rangeCount: 0, toString: () => ''
    };
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    selected = false;
    sentence.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    assert.equal(speech.calls.some(call => call[0] === 'speakOnce'), false);
  } finally {
    cleanup();
    env.restore();
  }
});

test('highlighted term selection suppresses its synthesized term action without stale state', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="0"]');
    const term = sentence.querySelector('.pc-term-word');
    let selected = true;
    let cleared = 0;
    env.window.getSelection = () => selected ? {
      anchorNode: term.firstChild,
      focusNode: term.firstChild,
      isCollapsed: false,
      toString: () => term.textContent,
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) }),
      removeAllRanges: () => { selected = false; cleared += 1; }
    } : {
      isCollapsed: true, rangeCount: 0, toString: () => '',
      removeAllRanges: () => { cleared += 1; }
    };

    term.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    const panel = env.root.querySelector('[data-role="selection-action"]');
    assert.ok(panel);
    selected = false;
    click(env.window, term);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), panel);
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
    assert.equal(speech.calls.some(call => call[0] === 'speakOnce'), false);

    click(env.window, sentence);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 1);
    assert.equal(speech.calls.some(call => call[0] === 'speakOnce'), false);

    click(env.window, sentence);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce'), [
      ['speakOnce', sentence.textContent]
    ]);
  } finally {
    cleanup();
    env.restore();
  }
});

test('ordinary sentence click speaks exactly once', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    click(env.window, sentence);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce'), [
      ['speakOnce', sentence.textContent]
    ]);
  } finally {
    cleanup();
    env.restore();
  }
});

test('selection menu exposes grouped actions and closes without speech', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    const outsideSentence = env.root.querySelector('[data-sentence-index="2"]');
    let cleared = 0;
    env.window.getSelection = () => validSelection(sentence, {
      text: 'Select this phrase',
      removeAllRanges: () => { cleared += 1; }
    });
    const openMenu = () => {
      sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
      return env.root.querySelector('[data-role="selection-action"]');
    };

    let panel = openMenu();
    assert.equal(panel.dataset.sentenceIndex, '1');
    assert.ok(panel.querySelector('[data-action="pronounce-selection"]'));
    assert.ok(panel.querySelector('[data-action="mark-selection"]'));
    assert.ok(panel.querySelector('[data-action="speech-start-selection"]'));
    assert.ok(panel.querySelector('[data-action="close-selection"]'));
    click(env.window, panel.querySelector('[data-role="reader-popover-word"]'));
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), panel);
    assert.equal(cleared, 0);

    click(env.window, panel.querySelector('[data-action="close-selection"]'));
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 1);

    panel = openMenu();
    panel.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 2);

    panel = openMenu();
    click(env.window, sentence);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), panel);
    click(env.window, outsideSentence);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 3);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce' || call[0] === 'startAt'), []);
  } finally {
    cleanup();
    env.restore();
  }
});

test('selection, marked term, and detail use the same popover skeleton', async () => {
  const env = installDom();
  const detail = articleDetail({
    markings: [
      {
        id: 'mw1', normalized_text: 'deployed', selected_text: 'Deployed',
        context_sentence: 'Deployed safely.', marked_term_id: null, word_id: 'w1', created_at: 3
      },
      {
        id: 'ma1', normalized_text: 'again', selected_text: 'Again',
        context_sentence: 'Again deploy.', marked_term_id: 'ta1', word_id: null, created_at: 4
      }
    ],
    pending_terms: [{
      id: 'ta1', display_text: 'Again', normalized_text: 'again', kind: 'word', created_at: 4
    }]
  });
  const cleanup = createReaderView({
    root: env.root, api: async () => detail, articleId: 'a1', navigate() {},
    speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    const selectionSentence = env.root.querySelector('[data-sentence-index="1"]');
    env.window.getSelection = () => validSelection(selectionSentence, { text: 'Select this phrase' });
    selectionSentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    assertSharedReaderPopover(env.root.querySelector('[data-role="selection-action"]'), 'Select this phrase');
    click(env.window, env.root.querySelector('[data-action="close-selection"]'));

    click(env.window, env.root.querySelector('.pc-term-pending'));
    let panel = env.root.querySelector('[data-role="term-popover"]');
    assertSharedReaderPopover(panel, 'Again');
    assert.ok(panel.querySelector('[data-role="reader-popover-ribbon"]'));
    assert.match(panel.querySelector('[data-role="reader-popover-status"]').textContent, /已标记为生词/);
    click(env.window, panel.querySelector('[data-action="close-popover"]'));

    click(env.window, env.root.querySelector('.pc-term-word'));
    panel = env.root.querySelector('[data-role="term-popover"]');
    assertSharedReaderPopover(panel, 'Deployed');
    assert.ok(panel.querySelector('[data-role="reader-popover-ribbon"]'));
    assert.match(panel.textContent, /deploy/);
    assert.match(panel.textContent, /词形：Deployed/);
    assert.match(panel.textContent, /部署；发布/);
    assert.match(panel.textContent, /They deployed\./);
    assert.match(panel.textContent, /de-PLOY/);
  } finally {
    cleanup();
    env.restore();
  }
});

test('marking a selection keeps the shared popover open in its marked state', async () => {
  const env = installDom();
  const calls = [];
  const initial = articleDetail({ words: [], markings: [], pending_terms: [] });
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/articles/a1' && !init.method) return initial;
    if (path === '/api/articles/a1/markings' && init.method === 'POST') {
      const input = JSON.parse(init.body);
      return {
        id: 'm2', normalized_text: input.normalizedText, selected_text: input.selectedText,
        context_sentence: input.contextSentence, marked_term_id: 't2', word_id: null, created_at: 3
      };
    }
    if (path === '/api/articles/a1/markings/m2' && init.method === 'DELETE') return { ok: true };
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    env.window.getSelection = () => validSelection(sentence, { text: 'Select this phrase' });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="mark-selection"]'));
    await flush();

    const marked = env.root.querySelector('[data-role="term-popover"]');
    assertSharedReaderPopover(marked, 'Select this phrase');
    assert.ok(marked.querySelector('[data-role="reader-popover-ribbon"]'));
    const bookmark = marked.querySelector('[data-role="reader-popover-bookmark"]');
    const cancel = marked.querySelector('[data-action="unmark-local"].pc-popover-secondary-action');
    assert.equal(bookmark.getAttribute('aria-pressed'), 'true');
    assert.equal(bookmark.dataset.action, 'unmark-local');
    assert.equal(cancel.dataset.markingId, 'm2');

    click(env.window, bookmark);
    await flush();
    assert.ok(calls.some(call => call.path === '/api/articles/a1/markings/m2' && call.init.method === 'DELETE'));
  } finally {
    cleanup();
    env.restore();
  }
});

test('term popover speech starts at its sentence and outside click restores trigger focus', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail({ words: [] }), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    let trigger = env.root.querySelector('.pc-term-pending');
    trigger.focus();
    click(env.window, trigger);
    click(env.window, env.root.querySelector('[data-role="reader-popover-tools"] [data-action="speech-start-popover"]'));
    assert.deepEqual(speech.calls.at(-1), ['startAt', 2]);
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);

    trigger = env.root.querySelector('.pc-term-pending');
    trigger.focus();
    click(env.window, trigger);
    const outside = env.window.document.createElement('button');
    env.window.document.body.append(outside);
    click(env.window, outside);
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    cleanup();
    env.restore();
  }
});

test('clicking the article outside a term popover dismisses without speaking the sentence', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail({ words: [] }), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('.pc-term-pending'));
    assert.ok(env.root.querySelector('[data-role="term-popover"]'));
    click(env.window, env.root.querySelector('[data-sentence-index="1"]'));
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce'), []);
  } finally {
    cleanup();
    env.restore();
  }
});

test('selection menu closes on Escape when focus is outside the reader root', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const outside = env.window.document.createElement('button');
  env.window.document.body.append(outside);
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    let cleared = 0;
    env.window.getSelection = () => validSelection(sentence, {
      text: 'Select this phrase', removeAllRanges: () => { cleared += 1; }
    });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    outside.focus();
    assert.equal(env.window.document.activeElement, outside);
    env.window.document.activeElement.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 1);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce' || call[0] === 'startAt'), []);
  } finally {
    cleanup();
    env.restore();
  }
});

test('selection menu closes on the second same-sentence reader click without speech', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    let selected = true;
    let cleared = 0;
    env.window.getSelection = () => selected ? validSelection(sentence, {
      text: 'Select this phrase', removeAllRanges: () => { cleared += 1; selected = false; }
    }) : {
      isCollapsed: true, rangeCount: 0, toString: () => '',
      removeAllRanges: () => { cleared += 1; }
    };
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    selected = false;

    click(env.window, sentence);
    assert.ok(env.root.querySelector('[data-role="selection-action"]'));
    assert.equal(cleared, 0);

    click(env.window, sentence);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 1);
    assert.equal(speech.calls.some(call => call[0] === 'speakOnce'), false);
  } finally {
    cleanup();
    env.restore();
  }
});

test('selection marking keeps its marked popover until an outside click dismisses it', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const api = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) return articleDetail();
    if (path === '/api/articles/a1/markings' && init.method === 'POST') {
      const input = JSON.parse(init.body);
      return {
        id: 'm2', normalized_text: input.normalizedText, selected_text: input.selectedText,
        context_sentence: input.contextSentence, marked_term_id: 't2', word_id: null, created_at: 3
      };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    let selected = true;
    env.window.getSelection = () => selected ? validSelection(sentence, {
      text: 'Select this phrase', removeAllRanges: () => { selected = false; }
    }) : { isCollapsed: true, rangeCount: 0, toString: () => '' };
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="mark-selection"]'));
    await flush();
    const renderedSentence = env.root.querySelector('[data-sentence-index="1"]');
    assert.ok(env.root.querySelector('[data-role="term-popover"]'));
    click(env.window, renderedSentence);
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce'), []);
    click(env.window, renderedSentence);
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce'), [
      ['speakOnce', renderedSentence.textContent]
    ]);
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader safely renders, prioritizes words, wires lookup speech, and marks one sentence selection', async () => {
  const env = installDom();
  const restoredTops = [];
  env.window.scrollTo = options => { restoredTops.push(options.top); };
  const calls = [];
  const spoken = [];
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/articles/a1' && !init.method) return articleDetail();
    if (path === '/api/articles/a1/markings' && init.method === 'POST') {
      const input = JSON.parse(init.body);
      return {
        id: 'm2', normalized_text: input.normalizedText, selected_text: input.selectedText,
        context_sentence: input.contextSentence, marked_term_id: 't2', word_id: null, created_at: 3
      };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {},
    progressRuntime: { requestAnimationFrame: callback => callback() },
    speech: {
      isSupported: true,
      speakOnce: text => spoken.push(text),
      load() {}, startAt() {}, pause() {}, resume() {}, setRate() {}, getRate: () => 1,
      subscribe: () => () => {}, stop() {}
    }
  });
  try {
    await flush();
    assert.deepEqual(restoredTops, [0]);
    assert.equal(env.root.querySelector('.pc-reader-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(env.root.querySelector('img'), null);
    assert.equal(env.root.querySelectorAll('[data-sentence-index]').length, 3);
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-sentence-index]')].map(node => node.dataset.sentenceIndex),
      ['0', '1', '2']
    );
    assert.equal(env.root.querySelector('.pc-term-word').textContent, 'Deployed');
    assert.equal(env.root.querySelector('.pc-term-pending'), null);

    click(env.window, env.root.querySelector('.pc-term-word'));
    const lookup = env.root.querySelector('[data-role="term-popover"]');
    assert.match(lookup.textContent, /Deployed/);
    assert.match(lookup.textContent, /deploy/);
    assert.match(lookup.textContent, /部署/);
    assert.match(lookup.textContent, /发布/);
    assert.match(lookup.textContent, /They deployed\./);
    assert.match(lookup.textContent, /de-PLOY/);
    click(env.window, lookup.querySelector('[data-action="pronounce"]'));
    assert.deepEqual(spoken, ['Deployed']);

    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    const textNode = sentence.firstChild;
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      toString: () => 'Select this phrase',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 30 }) }),
      removeAllRanges() {}
    };
    env.window.getSelection = () => selection;
    sentence.dispatchEvent(new env.window.MouseEvent('pointerup', { bubbles: true }));
    const selectionBar = env.root.querySelector('[data-role="selection-action"]');
    assert.ok(selectionBar);
    click(env.window, selectionBar.querySelector('[data-action="mark-selection"]'));
    await flush();

    const post = calls.find(call => call.init.method === 'POST');
    assert.deepEqual(JSON.parse(post.init.body), {
      selectedText: 'Select this phrase',
      normalizedText: 'select this phrase',
      contextSentence: 'Select this phrase.\n\n'
    });
    assert.equal(env.root.querySelector('[data-term-id="t2"]').textContent, 'Select this phrase');
  } finally {
    cleanup();
    env.restore();
  }
});

test('long article keeps compact controls and starts full reading at zero', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const body = Array.from({ length: 60 }, (_, index) => `Sentence ${index + 1}.`).join(' ');
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail({ body, words: [], pending_terms: [], markings: [] }),
    articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    assert.equal(env.root.querySelectorAll('[data-sentence-index]').length, 60);
    assert.equal(env.root.querySelector('[data-action="speech-start"]'), null);
    assert.equal(env.root.querySelectorAll('.pc-reader-speech option').length, 0);
    click(env.window, env.root.querySelector('[data-action="speech-play"]'));
    assert.deepEqual(speech.calls.at(-1), ['startAt', 0]);
  } finally {
    cleanup();
    env.restore();
  }
});

test('start full reading from the selected sentence closes the menu', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const body = Array.from({ length: 60 }, (_, index) => `Sentence ${index + 1}.`).join(' ');
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail({ body, words: [], pending_terms: [], markings: [] }),
    articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="37"]');
    let cleared = 0;
    env.window.getSelection = () => validSelection(sentence, {
      text: 'Sentence 38', removeAllRanges: () => { cleared += 1; }
    });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    const panel = env.root.querySelector('[data-role="selection-action"]');
    assert.equal(panel.dataset.sentenceIndex, '37');
    click(env.window, panel.querySelector('[data-action="speech-start-selection"]'));
    assert.deepEqual(speech.calls.filter(call => call[0] === 'startAt'), [['startAt', 37]]);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(cleared, 1);
  } finally {
    cleanup();
    env.restore();
  }
});

test('rate value follows real range input and controller rate', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const rate = env.root.querySelector('[data-action="speech-rate"]');
    const rateValue = env.root.querySelector('[data-role="speech-rate-value"]');
    assert.equal(rateValue.tagName, 'OUTPUT');
    assert.equal(rateValue.textContent, '1×');
    const returningSetRate = speech.controller.setRate;
    speech.controller.setRate = value => { speech.calls.push(['setRate', Number(value)]); };
    rate.value = '0.5';
    rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    assert.deepEqual(speech.calls.at(-1), ['setRate', 0.5]);
    assert.equal(rateValue.textContent, '0.5×');
    speech.controller.setRate = returningSetRate;
    rate.value = '1.5';
    rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    assert.deepEqual(speech.calls.at(-1), ['setRate', 1.5]);
    assert.equal(rateValue.textContent, '1.5×');
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader wires sequenced controls, rate, sentence and selection speech, active state, and cleanup', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles/a1') return articleDetail();
      throw new Error(`unexpected request ${path}`);
    },
    articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const loaded = speech.calls.find(call => call[0] === 'load');
    assert.equal(loaded[1].length, 3);

    click(env.window, env.root.querySelector('[data-action="speech-play"]'));
    click(env.window, env.root.querySelector('[data-action="speech-pause"]'));
    click(env.window, env.root.querySelector('[data-action="speech-resume"]'));
    click(env.window, env.root.querySelector('[data-action="speech-stop"]'));
    assert.deepEqual(speech.calls.slice(-4), [['startAt', 0], ['pause'], ['resume'], ['stop']]);

    const rate = env.root.querySelector('[data-action="speech-rate"]');
    assert.equal(rate.type, 'range');
    assert.deepEqual([rate.min, rate.max, rate.step, rate.value], ['0.5', '1.5', '0.5', '1']);
    rate.value = '1.5';
    rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    assert.deepEqual(speech.calls.at(-1), ['setRate', 1.5]);

    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    click(env.window, sentence);
    assert.deepEqual(speech.calls.at(-1), ['speakOnce', sentence.textContent]);
    const beforeTerm = speech.calls.length;
    click(env.window, env.root.querySelector('.pc-term-word'));
    assert.equal(speech.calls.length, beforeTerm);

    env.window.getSelection = () => ({
      anchorNode: sentence.firstChild,
      focusNode: sentence.firstChild,
      toString: () => 'Select this phrase',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) })
    });
    sentence.dispatchEvent(new env.window.MouseEvent('pointerup', { bubbles: true }));
    const afterSelection = speech.calls.length;
    click(env.window, sentence);
    assert.equal(speech.calls.length, afterSelection);
    click(env.window, env.root.querySelector('[data-action="pronounce-selection"]'));
    assert.deepEqual(speech.calls.at(-1), ['speakOnce', 'Select this phrase']);

    const speechStatus = env.root.querySelector('[data-role="speech-status"]');
    assert.equal(speechStatus.textContent, '');
    speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false, coverage: 0, counted: false } });
    assert.equal(sentence.classList.contains('pc-sentence-speaking'), true);
    assert.equal(speechStatus.textContent, '开始全文朗读');
    assert.equal(speechStatus.getAttribute('aria-live'), 'polite');
    speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false, coverage: 0.3, counted: false } });
    assert.equal(speechStatus.textContent, '开始全文朗读');
    speech.emit({ state: 'paused', currentIndex: 2, completion: { reachedEnd: false, coverage: 0.3, counted: false } });
    assert.equal(speechStatus.textContent, '全文朗读已暂停');
    speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false, coverage: 0.3, counted: false } });
    assert.equal(speechStatus.textContent, '继续全文朗读');
    click(env.window, env.root.querySelector('[data-action="speech-stop"]'));
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: false, coverage: 0, counted: false } });
    assert.equal(speechStatus.textContent, '全文朗读已停止');
    speech.emit({ state: 'once', currentIndex: null, completion: { reachedEnd: false, coverage: 0, counted: false } });
    assert.equal(speechStatus.textContent, '正在朗读所选内容');
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: false, coverage: 0, counted: false } });
    assert.equal(speechStatus.textContent, '所选内容朗读结束');
    speech.emit({ state: 'speaking', currentIndex: 0, completion: { reachedEnd: false, coverage: 0, counted: false } });
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: true, coverage: 1, counted: true } });
    assert.equal(speechStatus.textContent, '全文朗读完成');
    assert.equal(sentence.classList.contains('pc-sentence-speaking'), false);

    const play = env.root.querySelector('[data-action="speech-play"]');
    cleanup();
    const afterCleanup = speech.calls.length;
    click(env.window, play);
    rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    assert.equal(speech.calls.length, afterCleanup);
    assert.equal(speech.unsubscribed, 1);
    assert.deepEqual(speech.calls.at(-1), ['stop']);
  } finally {
    env.restore();
  }
});

test('reader popovers close with Escape and return focus to their trigger', async () => {
  const env = installDom();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {},
    speech: { isSupported: true, speakOnce() {}, load() {}, startAt() {}, pause() {}, resume() {}, setRate() {}, getRate: () => 1, subscribe: () => () => {}, stop() {} }
  });
  try {
    await flush();
    const trigger = env.root.querySelector('.pc-term-word');
    trigger.focus();
    click(env.window, trigger);
    assert.ok(env.root.querySelector('[data-role="term-popover"]'));
    env.root.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader persistently reports deferred progress without unhandled rejection', async () => {
  const env = installDom();
  const intervals = [];
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {},
    speech: { isSupported: true, speakOnce() {}, load() {}, startAt() {}, pause() {}, resume() {}, setRate() {}, getRate: () => 1, subscribe: () => () => {}, stop() {} },
    progressQueue: { submit: async () => false },
    progressRuntime: {
      setInterval: callback => { intervals.push(callback); return callback; },
      clearInterval() {}, requestAnimationFrame: callback => callback()
    }
  });
  try {
    await flush();
    intervals[0]();
    await flush();
    const error = env.root.querySelector('[data-role="reader-error"]');
    assert.equal(error.getAttribute('role'), 'alert');
    assert.match(error.textContent, /已暂存.*重试/);
    assert.equal(env.root.querySelectorAll('[data-role="reader-error"]').length, 1);
  } finally {
    cleanup();
    env.restore();
  }
});

test('pending conversion closes with Escape and returns focus to its trigger', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const term = {
    id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word',
    source_count: 1, created_at: 1, context_sentence: 'Deploy it.'
  };
  const cleanup = createPendingView({ root: env.root, api: async () => [term] });
  try {
    await flush();
    const trigger = env.root.querySelector('[data-action="convert"]');
    trigger.focus();
    click(env.window, trigger);
    const panel = env.root.querySelector('[data-role="conversion-panel"]');
    assert.equal(panel.getAttribute('role'), 'dialog');
    panel.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(env.root.querySelector('[data-role="conversion-panel"]'), null);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    cleanup();
    env.restore();
  }
});

async function exerciseSupersededReaderConversion(outcome) {
  const env = installDom();
  const conversionA = deferred();
  const conversionB = deferred();
  const outside = env.window.document.createElement('button');
  env.window.document.body.append(outside);
  let reads = 0;
  const pendingArticle = articleDetail({
    body: 'Deploy now. Remove later.',
    words: [],
    pending_terms: [
      { id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', created_at: 2 },
      { id: 't2', display_text: 'remove', normalized_text: 'remove', kind: 'word', created_at: 3 }
    ],
    markings: [
      { id: 'm1', normalized_text: 'deploy', selected_text: 'Deploy', context_sentence: 'Deploy now.', marked_term_id: 't1', word_id: null, created_at: 2 },
      { id: 'm2', normalized_text: 'remove', selected_text: 'Remove', context_sentence: 'Remove later.', marked_term_id: 't2', word_id: null, created_at: 3 }
    ]
  });
  const api = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) {
      reads += 1;
      return reads === 1 ? pendingArticle : articleDetail({ body: pendingArticle.body, words: [], pending_terms: [], markings: [] });
    }
    if (path === '/api/marked-terms/t1/add-to-word' && init.method === 'POST') return conversionA.promise;
    if (path === '/api/marked-terms/t2/add-to-word' && init.method === 'POST') return conversionB.promise;
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-term-id="t1"]'));
    click(env.window, env.root.querySelector('[data-action="convert-pending"]'));
    let form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '部署';
    submit(env.window, form);
    await Promise.resolve();

    click(env.window, env.root.querySelector('[data-term-id="t2"]'));
    click(env.window, env.root.querySelector('[data-action="convert-pending"]'));
    form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '移除';
    submit(env.window, form);
    await Promise.resolve();

    if (outcome === 'resolve') conversionA.resolve({ id: 'w1', lemma: 'deploy', zh: '部署', forms: [] });
    else conversionA.reject(new Error('conversion A failed'));
    await flush();

    outside.focus();
    env.window.document.activeElement.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.ok(env.root.querySelector('[data-role="conversion-panel"]'));

    conversionB.resolve({ id: 'w2', lemma: 'remove', zh: '移除', forms: [] });
    await flush();
    await flush();
    assert.equal(reads, 2);
    assert.equal(env.root.querySelector('.pc-term-pending'), null);
  } finally {
    cleanup();
    env.restore();
  }
}

test('resolved superseded conversion cannot clear the current conversion busy state', async () => {
  await exerciseSupersededReaderConversion('resolve');
});

test('rejected superseded conversion cannot clear the current conversion busy state', async () => {
  await exerciseSupersededReaderConversion('reject');
});

test('reader keeps a submitting conversion open on Escape and refreshes after success', async () => {
  const env = installDom();
  const conversion = deferred();
  const outside = env.window.document.createElement('button');
  env.window.document.body.append(outside);
  let reads = 0;
  const api = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) {
      reads += 1;
      return reads === 1 ? articleDetail({ words: [] }) : articleDetail({ words: [], pending_terms: [], markings: [] });
    }
    if (path === '/api/marked-terms/t1/add-to-word' && init.method === 'POST') return conversion.promise;
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('.pc-term-pending'));
    click(env.window, env.root.querySelector('[data-action="convert-pending"]'));
    const form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '部署';
    submit(env.window, form);
    await Promise.resolve();
    outside.focus();
    assert.equal(env.window.document.activeElement, outside);
    click(env.window, outside);
    assert.ok(env.root.querySelector('[data-role="conversion-panel"]'));
    env.window.document.activeElement.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.ok(env.root.querySelector('[data-role="conversion-panel"]'));
    conversion.resolve({ id: 'w1', lemma: 'deploy', zh: '部署', forms: [] });
    await flush();
    await flush();
    assert.equal(reads, 2);
    assert.equal(env.root.querySelector('[data-role="conversion-panel"]'), null);
    assert.equal(env.root.querySelector('.pc-term-pending'), null);
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader closes an idle conversion on Escape from outside the reader root', async () => {
  const env = installDom();
  const outside = env.window.document.createElement('button');
  env.window.document.body.append(outside);
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail({ words: [] }), articleId: 'a1', navigate() {},
    speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    const trigger = env.root.querySelector('.pc-term-pending');
    click(env.window, trigger);
    click(env.window, env.root.querySelector('[data-action="convert-pending"]'));
    assert.ok(env.root.querySelector('[data-role="conversion-panel"]'));
    outside.focus();
    env.window.document.activeElement.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.querySelector('[data-role="conversion-panel"]'), null);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    cleanup();
    env.restore();
  }
});

test('failed current conversion releases busy so outside Escape can close it', async () => {
  const env = installDom();
  const conversion = deferred();
  const outside = env.window.document.createElement('button');
  env.window.document.body.append(outside);
  const api = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) return articleDetail({ words: [] });
    if (path === '/api/marked-terms/t1/add-to-word' && init.method === 'POST') return conversion.promise;
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('.pc-term-pending'));
    click(env.window, env.root.querySelector('[data-action="convert-pending"]'));
    const form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '部署';
    submit(env.window, form);
    await Promise.resolve();
    conversion.reject(new Error('conversion B failed'));
    await flush();
    assert.equal(env.root.querySelector('[data-role="conversion-error"]').textContent, 'conversion B failed');

    outside.focus();
    env.window.document.activeElement.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.querySelector('[data-role="conversion-panel"]'), null);
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader clears only an acknowledged deferred-progress alert', async () => {
  const env = installDom();
  const intervals = [];
  const outcomes = [false, true, false, false, true];
  const api = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) return articleDetail({ words: [] });
    if (path === '/api/articles/a1/markings/m1' && init.method === 'DELETE') throw new Error('取消标记失败');
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller,
    progressQueue: { submit: async () => outcomes.shift() ?? true },
    progressRuntime: { now: () => 1_000, setInterval: callback => { intervals.push(callback); return callback; }, clearInterval() {}, requestAnimationFrame: callback => callback() }
  });
  try {
    await flush();
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').dataset.errorKind, 'progress');
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]'), null);
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').dataset.errorKind, 'progress');
    click(env.window, env.root.querySelector('.pc-term-pending'));
    click(env.window, env.root.querySelector('[data-action="unmark-local"]'));
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').textContent, '取消标记失败');
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').textContent, '取消标记失败');
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').textContent, '取消标记失败');
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader progress alerts ignore stale out-of-order outcomes', async () => {
  const env = installDom();
  const intervals = [];
  const submissions = [];
  const cleanup = createReaderView({
    root: env.root,
    api: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail({ words: [] });
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller,
    progressQueue: { submit: () => {
      const request = deferred();
      submissions.push(request);
      return request.promise;
    } },
    progressRuntime: { setInterval: callback => { intervals.push(callback); return callback; }, clearInterval() {}, requestAnimationFrame: callback => callback() }
  });
  try {
    await flush();
    intervals[0]();
    intervals[0]();
    submissions[1].resolve(true);
    await flush();
    submissions[0].resolve(false);
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]'), null);

    intervals[0]();
    intervals[0]();
    submissions[3].resolve(false);
    await flush();
    submissions[2].resolve(true);
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').dataset.errorKind, 'progress');
  } finally {
    cleanup();
    env.restore();
  }
});

test('pending delete clears a stale failure after a successful retry', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  let attempts = 0;
  const term = { id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', source_count: 1, created_at: 1 };
  const api = async (path, init = {}) => {
    if (path === '/api/marked-terms' && !init.method) return [term];
    if (path === '/api/marked-terms/t1' && init.method === 'DELETE') {
      attempts += 1;
      if (attempts === 1) throw new Error('取消失败');
      return { ok: true };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="delete-global"]'));
    await flush();
    assert.equal(env.root.querySelector('.pc-inline-error').textContent, '取消失败');
    click(env.window, env.root.querySelector('[data-action="delete-global"]'));
    await flush();
    assert.equal(env.root.querySelector('.pc-inline-error'), null);
  } finally {
    cleanup();
    env.restore();
  }
});

test('conflict conversion disables every action while merge is pending and restores after failure', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const merge = deferred();
  const term = { id: 't1', display_text: 'deployed', normalized_text: 'deployed', kind: 'word', source_count: 1, created_at: 1 };
  const api = async (path, init = {}) => {
    if (path === '/api/marked-terms' && !init.method) return [term];
    if (path.endsWith('/add-to-word') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.strategy === 'merge') return merge.promise;
      const error = new Error('exists');
      error.status = 409;
      error.code = 'LEMMA_EXISTS';
      error.data = { matches: [{ id: 'w1', lemma: 'deploy', zh: '部署' }] };
      throw error;
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="convert"]'));
    const form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '发布';
    submit(env.window, form);
    await flush();
    click(env.window, form.querySelector('[data-action="merge-candidate"]'));
    await Promise.resolve();
    assert.ok([...form.querySelectorAll('button')].every(button => button.disabled));
    merge.reject(new Error('merge failed'));
    await flush();
    assert.ok([...form.querySelectorAll('button')].every(button => !button.disabled));
    assert.equal(form.querySelector('[data-role="conversion-error"]').textContent, 'merge failed');
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader disables speech controls and explains unsupported browsers', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake(false);
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const controls = [...env.root.querySelectorAll('[data-speech-control]')];
    assert.ok(controls.length >= 5);
    assert.ok(controls.every(control => control.disabled));
    assert.match(env.root.querySelector('[data-role="speech-unavailable"]').textContent, /浏览器.*语音/);
    click(env.window, env.root.querySelector('.pc-term-word'));
    assert.equal(env.root.querySelector('[data-action="pronounce"]').disabled, true);
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader rejects cross-sentence selection and local delete refreshes global highlight state', async () => {
  const env = installDom();
  const calls = [];
  const navigations = [];
  let reads = 0;
  const initial = articleDetail({ words: [] });
  const afterDelete = articleDetail({ markings: [], pending_terms: [], words: [] });
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/articles/a1' && !init.method) return reads++ ? afterDelete : initial;
    if (path === '/api/articles/a1/markings/m1' && init.method === 'DELETE') return { ok: true };
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate: route => navigations.push(route),
    speech: { isSupported: true, speakOnce() {}, load() {}, startAt() {}, pause() {}, resume() {}, setRate() {}, getRate: () => 1, subscribe: () => () => {}, stop() {} }
  });
  try {
    await flush();
    const sentences = env.root.querySelectorAll('[data-sentence-index]');
    env.window.getSelection = () => ({
      anchorNode: sentences[0].firstChild,
      focusNode: sentences[1].firstChild,
      toString: () => 'safely. Select',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) })
    });
    sentences[1].dispatchEvent(new env.window.MouseEvent('pointerup', { bubbles: true }));
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);

    click(env.window, env.root.querySelector('.pc-term-pending'));
    const popover = env.root.querySelector('[data-role="term-popover"]');
    click(env.window, popover.querySelector('[data-action="unmark-local"]'));
    await flush();
    assert.ok(calls.some(call => call.path === '/api/articles/a1/markings/m1' && call.init.method === 'DELETE'));
    assert.equal(env.root.querySelector('.pc-term-pending'), null);

    const back = env.root.querySelector('[data-action="back-library"]');
    const liveSentence = env.root.querySelector('[data-sentence-index="1"]');
    env.window.getSelection = () => ({
      anchorNode: liveSentence.firstChild,
      focusNode: liveSentence.firstChild,
      toString: () => 'Select this phrase',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 1, bottom: 2 }) })
    });
    cleanup();
    const before = calls.length;
    click(env.window, back);
    liveSentence.dispatchEvent(new env.window.MouseEvent('pointerup', { bubbles: true }));
    assert.equal(calls.length, before);
    assert.deepEqual(navigations, []);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
  } finally {
    env.restore();
  }
});

test('pending organizer wires conflict merge/new conversions, global delete, errors, and cleanup', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const calls = [];
  const pending = [
    { id: 't1', display_text: '<b>Deployed</b>', normalized_text: 'deployed', kind: 'word', source_count: 2, created_at: 30, context_sentence: 'They deployed.' },
    { id: 't2', display_text: 'roll out', normalized_text: 'roll out', kind: 'phrase', source_count: 1, created_at: 20, context_sentence: 'We roll out.' },
    { id: 't3', display_text: 'remove', normalized_text: 'remove', kind: 'word', source_count: 1, created_at: 10, context_sentence: 'Remove it.' }
  ];
  const conflicts = new Set();
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/marked-terms' && !init.method) return pending;
    if (/\/add-to-word$/.test(path) && init.method === 'POST') {
      const input = JSON.parse(init.body);
      if (!input.strategy) {
        conflicts.add(path);
        const error = new Error('exists');
        error.status = 409;
        error.code = 'LEMMA_EXISTS';
        error.data = { matches: [{ id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署', example: 'Old example.' }] };
        throw error;
      }
      return { id: input.targetWordId || `word-${input.strategy}`, en: input.lemma, lemma: input.lemma, zh: input.zh, forms: [] };
    }
    if (path === '/api/marked-terms/t3' && init.method === 'DELETE') return { ok: true };
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    assert.equal(env.root.querySelector('b'), null);
    assert.deepEqual([...env.root.querySelectorAll('[data-term-id]')].map(row => row.dataset.termId), ['t1', 't2', 't3']);

    click(env.window, env.root.querySelector('[data-term-id="t1"] [data-action="convert"]'));
    let form = env.root.querySelector('[data-role="conversion-form"]');
    assert.equal(form.elements.example.value, 'They deployed.');
    form.elements.zh.value = '发布';
    form.elements.lemma.value = 'deploy';
    submit(env.window, form);
    await flush();
    assert.ok(conflicts.has('/api/marked-terms/t1/add-to-word'));
    assert.match(env.root.querySelector('[data-role="conversion-conflict"]').textContent, /保留旧例句/);
    form.elements.example.value = 'Edited before merge.';
    click(env.window, env.root.querySelector('[data-action="merge-candidate"][data-word-id="w1"]'));
    await flush();
    const mergeCall = calls.find(call => JSON.parse(call.init.body || '{}').strategy === 'merge');
    assert.deepEqual(JSON.parse(mergeCall.init.body), {
      zh: '发布', lemma: 'deploy', example: 'Edited before merge.', stress: '', strategy: 'merge', targetWordId: 'w1'
    });
    assert.equal(env.root.querySelector('[data-term-id="t1"]'), null);

    click(env.window, env.root.querySelector('[data-term-id="t2"] [data-action="convert"]'));
    form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '推出';
    form.elements.lemma.value = 'roll out';
    submit(env.window, form);
    await flush();
    click(env.window, env.root.querySelector('[data-action="create-separate"]'));
    await flush();
    const newCall = calls.find(call => JSON.parse(call.init.body || '{}').strategy === 'new');
    assert.equal(JSON.parse(newCall.init.body).targetWordId, undefined);
    assert.equal(env.root.querySelector('[data-term-id="t2"]'), null);

    click(env.window, env.root.querySelector('[data-term-id="t3"] [data-action="delete-global"]'));
    await flush();
    assert.ok(calls.some(call => call.path === '/api/marked-terms/t3' && call.init.method === 'DELETE'));
    assert.equal(env.root.querySelector('[data-term-id="t3"]'), null);
    assert.ok(env.root.querySelector('.pc-empty'));

    cleanup();
    const before = calls.length;
    env.root.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calls.length, before);
  } finally {
    env.restore();
  }
});

test('pending conversion blocks an unrelated row deletion and completes without stale state', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  let resolveConversion;
  const conversion = new Promise(resolve => { resolveConversion = resolve; });
  const calls = [];
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/marked-terms' && !init.method) return [
      { id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', source_count: 1, created_at: 2, context_sentence: 'Deploy it.' },
      { id: 't2', display_text: 'remove', normalized_text: 'remove', kind: 'word', source_count: 1, created_at: 1, context_sentence: 'Remove it.' }
    ];
    if (path === '/api/marked-terms/t1/add-to-word' && init.method === 'POST') return conversion;
    if (path === '/api/marked-terms/t2' && init.method === 'DELETE') return { ok: true };
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-term-id="t1"] [data-action="convert"]'));
    const form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '部署';
    submit(env.window, form);
    click(env.window, env.root.querySelector('[data-term-id="t2"] [data-action="delete-global"]'));
    await flush();
    assert.ok(env.root.querySelector('[data-term-id="t2"]'));
    assert.equal(calls.filter(call => call.path === '/api/marked-terms/t2').length, 0);

    resolveConversion({ id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署', forms: [] });
    await flush();

    assert.equal(env.root.querySelector('[data-term-id="t1"]'), null);
    assert.ok(env.root.querySelector('[data-term-id="t2"]'));
    assert.equal(calls.filter(call => call.path === '/api/marked-terms/t1/add-to-word').length, 1);
  } finally {
    cleanup();
    env.restore();
  }
});

test('pending cleanup removes delegation from still-mounted real row actions', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const calls = [];
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/marked-terms' && !init.method) return [
      { id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', source_count: 1, created_at: 1, context_sentence: 'Deploy.' }
    ];
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    const action = env.root.querySelector('[data-action="convert"]');
    cleanup();
    click(env.window, action);
    assert.equal(env.root.querySelector('[data-role="conversion-form"]'), null);
    assert.equal(calls.length, 1);
  } finally {
    env.restore();
  }
});

test('app coordinator mounts pending and reader views from their real hash routes', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    if (path === '/api/me') return Response.json({ username: 'joe' });
    if (path === '/api/marked-terms') return Response.json([]);
    if (path === '/api/articles/a1') return Response.json(articleDetail());
    if (path === '/api/article-stats') return Response.json([{
      id: 'a1', title: 'Stats article', read_count: 1, active_read_ms: 1000,
      marking_count: 2, pending_marking_count: 1, converted_marking_count: 1,
      full_read_aloud_count: 3
    }]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  try {
    await import(`../public/app.js?reader-route-test=${Date.now()}`);
    await flush();
    assert.match(env.root.textContent, /没有待整理标记/);

    env.window.location.hash = '#/articles/reader/a1';
    env.window.dispatchEvent(new env.window.HashChangeEvent('hashchange'));
    await flush();
    assert.equal(env.root.querySelector('.pc-reader-title').textContent, '<img src=x onerror=alert(1)>');

    env.window.location.hash = '#/articles/stats';
    env.window.dispatchEvent(new env.window.HashChangeEvent('hashchange'));
    await flush();
    assert.equal(env.root.querySelector('[data-article-id="a1"] .pc-article-title').textContent, 'Stats article');
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test('logout unmounts the reader and acknowledges its queued progress before ending the session', async () => {
  const env = installDom('http://local.test/#/articles/reader/a1');
  env.window.scrollTo = () => {};
  const calls = [];
  const progressAck = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    calls.push(`${init.method || 'GET'} ${path}`);
    if (path === '/api/me') return Response.json({ username: 'alice' });
    if (path === '/api/articles/a1' && !init.method) return Response.json(articleDetail());
    if (path === '/api/articles/a1/progress' && init.method === 'PATCH') return progressAck.promise;
    if (path === '/api/logout' && init.method === 'POST') return Response.json({ ok: true });
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  try {
    await import(`../public/app.js?logout-order-test=${Date.now()}`);
    await flush();
    click(env.window, env.root.querySelector('.pc-account-actions button:last-child'));
    const progressIndex = calls.indexOf('PATCH /api/articles/a1/progress');
    assert.ok(progressIndex >= 0);
    assert.equal(calls.includes('POST /api/logout'), false);
    progressAck.resolve(Response.json({ ok: true }));
    await flush();
    assert.ok(calls.indexOf('POST /api/logout') > progressIndex);
    assert.match(env.root.textContent, /登录/);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test('app still boots when the localStorage getter is disabled', async () => {
  const env = installDom('http://local.test/#/words');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage disabled'); }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async path => {
    if (path === '/api/me') return Response.json({ username: 'alice' });
    if (path === '/api/words') return Response.json([]);
    throw new Error(`unexpected request GET ${path}`);
  };
  try {
    await import(`../public/app.js?disabled-storage-test=${Date.now()}`);
    await flush();
    assert.match(env.root.textContent, /记词本/);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test('booting account B never retries account A work from the former shared queue', async () => {
  const env = installDom('http://local.test/#/words');
  env.window.localStorage.setItem('pc-progress-queue', JSON.stringify([{
    kind: 'event', articleId: 'alice-article',
    event: { id: 'alice-event', type: 'read_complete', amount: 1 }
  }]));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    calls.push(`${init.method || 'GET'} ${path}`);
    if (path === '/api/me') return Response.json({ username: 'bob' });
    if (path === '/api/words') return Response.json([]);
    if (String(path).includes('alice-article')) throw new Error('identity leak');
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  try {
    await import(`../public/app.js?account-isolation-test=${Date.now()}`);
    await flush();
    env.window.dispatchEvent(new env.window.Event('online'));
    await flush();
    assert.equal(calls.some(call => call.includes('alice-article')), false);
    assert.ok(env.window.localStorage.getItem('pc-progress-queue'));
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test('pending organizer serializes unrelated mutations while a conversion is in flight', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const conversion = deferred();
  let deleteCalls = 0;
  const terms = [
    { id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', source_count: 1, created_at: 2, context_sentence: 'Deploy it.' },
    { id: 't2', display_text: 'remove', normalized_text: 'remove', kind: 'word', source_count: 1, created_at: 1, context_sentence: 'Remove it.' }
  ];
  const api = async (path, init = {}) => {
    if (path === '/api/marked-terms' && !init.method) return terms;
    if (path === '/api/marked-terms/t1/add-to-word' && init.method === 'POST') return conversion.promise;
    if (path === '/api/marked-terms/t2' && init.method === 'DELETE') {
      deleteCalls += 1;
      return { ok: true };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-term-id="t1"] [data-action="convert"]'));
    const form = env.root.querySelector('[data-role="conversion-form"]');
    form.elements.zh.value = '部署';
    submit(env.window, form);
    await Promise.resolve();

    const activeTitle = env.root.querySelector('.pc-conversion-title').textContent;
    click(env.window, env.root.querySelector('[data-term-id="t2"] [data-action="convert"]'));
    assert.equal(env.root.querySelector('.pc-conversion-title').textContent, activeTitle);
    click(env.window, env.root.querySelector('[data-term-id="t2"] [data-action="delete-global"]'));
    assert.equal(deleteCalls, 0);
    assert.equal(env.root.querySelector('[data-term-id="t2"] [data-action="delete-global"]').disabled, true);

    conversion.resolve({ id: 'w1', lemma: 'deploy', zh: '部署', forms: [] });
    await flush();
    assert.equal(env.root.querySelector('[data-term-id="t1"]'), null);
    assert.ok(env.root.querySelector('[data-term-id="t2"]'));
  } finally {
    cleanup();
    env.restore();
  }
});

test('reader cleanup removes real click, pointer selection, and document key listeners', async () => {
  const env = installDom();
  let navigations = 0;
  let cleared = 0;
  const api = async path => {
    if (path === '/api/articles/a1') return articleDetail();
    throw new Error(`unexpected request ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate: () => { navigations += 1; },
    speech: { isSupported: true, speakOnce() {}, load() {}, startAt() {}, pause() {}, resume() {}, setRate() {}, getRate: () => 1, subscribe: () => () => {}, stop() {} }
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    env.window.getSelection = () => ({
      anchorNode: sentence.firstChild,
      focusNode: sentence.firstChild,
      toString: () => 'Select this phrase',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) }),
      removeAllRanges: () => { cleared += 1; }
    });
    const back = env.root.querySelector('[data-action="back-library"]');
    const term = env.root.querySelector('.pc-term-word');
    cleanup();
    assert.equal(cleared, 1);

    click(env.window, back);
    click(env.window, term);
    sentence.dispatchEvent(new env.window.MouseEvent('pointerup', { bubbles: true }));
    assert.equal(navigations, 0);
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    const stalePanel = env.window.document.createElement('div');
    stalePanel.dataset.role = 'selection-action';
    env.root.append(stalePanel);
    env.window.document.body.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(stalePanel.isConnected, true);
  } finally {
    env.restore();
  }
});

test('reader cleanup removes outside-click dismissal from an existing popover', async () => {
  const env = installDom();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {},
    speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    click(env.window, env.root.querySelector('.pc-term-word'));
    const panel = env.root.querySelector('[data-role="term-popover"]');
    assert.ok(panel);
    cleanup();
    click(env.window, env.window.document.body);
    assert.equal(panel.isConnected, true);
  } finally {
    env.restore();
  }
});

test('reader restores position without completing, then queues reading, time, position and aloud progress', async () => {
  const env = installDom();
  let now = 0;
  let scrollY = 1000;
  const submitted = [];
  const speech = createReaderSpeechFake();
  Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(env.window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(env.window.document.documentElement, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(env.window.document, 'visibilityState', { configurable: true, value: 'visible' });
  env.window.scrollTo = ({ top }) => { scrollY = top; };
  const intervals = [];
  const cleanup = createReaderView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles/a1') return articleDetail({ progress: { last_position_ratio: 0 } });
      throw new Error(`unexpected request ${path}`);
    },
    articleId: 'a1', navigate() {}, speech: speech.controller,
    progressQueue: { submit: async item => { submitted.push(item); return true; } },
    progressRuntime: {
      now: () => now,
      randomUUID: (() => { let id = 0; return () => `event-${++id}`; })(),
      setInterval: callback => { intervals.push(callback); return callback; },
      clearInterval() {},
      requestAnimationFrame: callback => callback()
    }
  });
  try {
    await flush();
    assert.equal(scrollY, 0);
    assert.equal(submitted.some(item => item.event?.type === 'read_complete'), false);

    scrollY = 0;
    env.window.dispatchEvent(new env.window.Event('scroll'));
    now = 30_000;
    scrollY = 1000;
    env.window.dispatchEvent(new env.window.Event('scroll'));
    assert.equal(submitted.filter(item => item.event?.type === 'read_complete').length, 1);

    speech.emit({
      state: 'idle', currentIndex: null,
      completion: { reachedEnd: true, coverage: 1, counted: true },
      completionEvent: { reachedEnd: true, coverage: 1, counted: true }
    });
    assert.equal(submitted.filter(item => item.event?.type === 'read_aloud_complete').length, 1);

    intervals[0]();
    await Promise.resolve();
    assert.equal(submitted.filter(item => item.event?.type === 'active_ms').at(-1).event.amount, 30_000);
    assert.equal(submitted.filter(item => item.kind === 'position').at(-1).lastPositionRatio, 1);

    now = 100_000;
    intervals[0]();
    click(env.window, env.root.querySelector('[data-sentence-index="0"]'));
    now = 105_000;
    intervals[0]();
    assert.equal(submitted.filter(item => item.event?.type === 'active_ms').at(-1).event.amount, 5_000);

    now = 170_000;
    Object.defineProperty(env.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    const activeBeforeCompletion = submitted.filter(item => item.event?.type === 'active_ms').length;
    now = 180_000;
    speech.emit({
      state: 'idle', currentIndex: null,
      completion: { reachedEnd: true, coverage: 1, counted: true },
      completionEvent: { reachedEnd: true, coverage: 1, counted: true }
    });
    Object.defineProperty(env.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    now = 240_000;
    intervals[0]();
    assert.equal(submitted.filter(item => item.event?.type === 'active_ms').length, activeBeforeCompletion);

    now = 250_000;
    const rate = env.root.querySelector('[data-action="speech-rate"]');
    rate.value = '1.5';
    rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    now = 255_000;
    intervals[0]();
    assert.equal(submitted.filter(item => item.event?.type === 'active_ms').at(-1).event.amount, 5_000);
  } finally {
    cleanup();
    env.restore();
  }
});

test('pending cleanup removes the real delegated row action listener', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  let deleteCalls = 0;
  const term = { id: 't1', display_text: 'deploy', normalized_text: 'deploy', kind: 'word', source_count: 1, created_at: 1 };
  const api = async (path, init = {}) => {
    if (path === '/api/marked-terms' && !init.method) return [term];
    if (path === '/api/marked-terms/t1' && init.method === 'DELETE') {
      deleteCalls += 1;
      return { ok: true };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    const remove = env.root.querySelector('[data-action="delete-global"]');
    cleanup();
    click(env.window, remove);
    await flush();
    assert.equal(deleteCalls, 0);
  } finally {
    env.restore();
  }
});
