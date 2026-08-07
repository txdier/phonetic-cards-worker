import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createAloudCheckpointStore } from '../public/lib/aloud-checkpoint.js';
import { READER_PREFERENCES_KEY } from '../public/lib/reader-preferences.js';
import { createProgressQueue, PROGRESS_QUEUE_KEY } from '../public/lib/reading-session.js';
import { TRANSLATION_MODE_KEY } from '../public/lib/translation-preferences.js';
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

async function waitFor(
  predicate,
  message = 'condition was not reached',
  timeoutMs = 3000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  if (predicate()) return;
  assert.fail(message);
}

async function translationSourceHash(value) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function click(window, node) {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function acceptConfirmation(window) {
  click(window, window.document.querySelector('[data-action="confirm-dialog-confirm"]'));
}

function validSelection(sentence, {
  text = sentence.textContent, removeAllRanges = () => {}, rect = {}
} = {}) {
  return {
    anchorNode: sentence.firstChild,
    focusNode: sentence.firstChild,
    isCollapsed: false,
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({ getBoundingClientRect: () => rect }),
    removeAllRanges
  };
}

function controlledTimeouts() {
  let nextId = 0;
  const tasks = new Map();
  const cleared = [];
  return {
    runtime: {
      setTimeout(callback, delay) {
        const id = ++nextId;
        tasks.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        cleared.push(id);
        tasks.delete(id);
      }
    },
    tasks,
    cleared,
    runLatest() {
      const entry = [...tasks.entries()].at(-1);
      if (!entry) return;
      const [id, task] = entry;
      tasks.delete(id);
      task.callback();
    }
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

function progressiveArticleTranslation(completed = [], completedBatch = null, {
  totalBatches = 4,
  titleZh = 'Translated title',
  translations = {}
} = {}) {
  const completedIndexes = new Set(completed);
  const batches = Array.from({ length: totalBatches }, (_, index) => ({
    index,
    paragraphIndexes: [index],
    completed: completedIndexes.has(index)
  }));
  return {
    status: completed.length === batches.length
      ? 'fresh'
      : completed.length ? 'partial' : 'missing',
    sourceHash: 'a'.repeat(64),
    rulesVersion: 'article-v2-progressive',
    titleZh: completedIndexes.has(0) ? titleZh : '',
    paragraphs: completed.map(index => ({
      index,
      translation: translations[index] ?? `translation ${index}`
    })),
    batches,
    completedBatches: completed.length,
    totalBatches: batches.length,
    ...(completedBatch == null ? {} : { completedBatch })
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

function createReaderTtsFake(initialSnapshot = {}, { publishStart = true } = {}) {
  const starts = [];
  const calls = [];
  let listener = null;
  let rate = 1;
  let snapshot = {
    state: 'idle',
    mode: 'idle',
    articleId: null,
    currentIndex: null,
    currentTime: 0,
    completion: { reachedEnd: false, coverage: 0, counted: false },
    fallbackActive: false,
    ...initialSnapshot
  };
  const publish = next => {
    snapshot = {
      ...snapshot,
      ...next,
      completion: next.completion || snapshot.completion
    };
    listener?.({ ...snapshot });
  };
  return {
    starts,
    calls,
    get pauseCalls() { return calls.filter(call => call === 'pause').length; },
    controller: {
      isSupported: true,
      getRate: () => rate,
      setRate(value) {
        rate = Number(value);
        calls.push(['rate', rate]);
        return rate;
      },
      getSnapshot: () => ({ ...snapshot }),
      subscribe(next) {
        listener = next;
        next({ ...snapshot });
        return () => { listener = null; };
      },
      startArticle(nextArticleId, sentences, startIndex, options = {}) {
        const started = {
          articleId: nextArticleId,
          startIndex,
          offsetSeconds: Number(options.offsetSeconds || 0)
        };
        if (options.profile) started.profile = options.profile;
        starts.push(started);
        if (!publishStart) return;
        publish({
          state: 'speaking',
          mode: 'article',
          articleId: nextArticleId,
          currentIndex: startIndex,
          currentTime: Number(options.offsetSeconds || 0),
          completion: { reachedEnd: false, coverage: 0, counted: false }
        });
      },
      pause() {
        calls.push('pause');
        if (snapshot.state === 'speaking') publish({ state: 'paused' });
      },
      resume() {
        calls.push('resume');
        if (snapshot.state === 'paused') publish({ state: 'speaking' });
      },
      previousSentence() { calls.push('previous'); },
      replayCurrentSentence() { calls.push('current'); },
      nextSentence() { calls.push('next'); },
      speakArticleSentence(nextArticleId, index, text, options = {}) {
        calls.push(['point', nextArticleId, index, text, options.profile]);
        publish({
          state: 'once',
          mode: 'once',
          articleId: null,
          currentIndex: null,
          currentTime: 0
        });
      },
      stop() {
        calls.push('stop');
        publish({
          state: 'idle',
          mode: 'idle',
          articleId: null,
          currentIndex: null,
          currentTime: 0
        });
      }
    },
    emit: publish
  };
}

function setupReader({
  articleProgress = {
    last_position_ratio: 0,
    last_aloud_sentence_index: 0,
    last_aloud_offset_seconds: 1
  },
  body = 'First sentence. Second sentence. Third sentence.',
  checkpoint = null,
  checkpointBody = body,
  liveSnapshot = {},
  publishStart = true,
  timerDeadline = null,
  translationMode = null,
  useTts = true,
  now: initialNow = 0,
  apiImpl = null
} = {}) {
  const env = installDom();
  let currentNow = initialNow;
  const timerKey = 'pc-aloud-timer:alice:a1';
  if (timerDeadline != null) {
    env.window.localStorage.setItem(timerKey, JSON.stringify({ deadline: timerDeadline }));
  }
  if (translationMode != null) {
    env.window.localStorage.setItem(TRANSLATION_MODE_KEY, translationMode);
  }
  const baseCheckpointStore = createAloudCheckpointStore({
    storage: env.window.localStorage,
    username: 'alice',
    now: () => currentNow
  });
  if (checkpoint) {
    baseCheckpointStore.save({
      articleId: 'a1',
      body: checkpointBody,
      sentenceIndex: checkpoint.sentenceIndex,
      offsetSeconds: checkpoint.offsetSeconds,
      state: checkpoint.state
    });
  }
  const checkpointSaves = [];
  let clearedArticleId = null;
  const checkpointStore = {
    load: options => baseCheckpointStore.load(options),
    save(options) {
      checkpointSaves.push({
        sentenceIndex: options.sentenceIndex,
        offsetSeconds: options.offsetSeconds,
        state: options.state
      });
      return baseCheckpointStore.save(options);
    },
    clear(nextArticleId) {
      clearedArticleId = nextArticleId;
      return baseCheckpointStore.clear(nextArticleId);
    },
    get lastSaved() { return checkpointSaves.at(-1) || null; },
    get clearedArticleId() { return clearedArticleId; }
  };
  const progressItems = [];
  const progressQueue = {
    submit(item) {
      progressItems.push({ ...item });
      return Promise.resolve(true);
    },
    retry: () => Promise.resolve(true),
    snapshot: () => progressItems.map(item => ({ ...item }))
  };
  const speech = createReaderSpeechFake();
  const tts = createReaderTtsFake(liveSnapshot, { publishStart });
  const handlers = new Map();
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    handlers,
    setActionHandler(name, handler) {
      if (handler) handlers.set(name, handler);
      else handlers.delete(name);
    }
  };
  class MediaMetadata {
    constructor(value) { Object.assign(this, value); }
  }
  const intervals = [];
  const cleanup = createReaderView({
    root: env.root,
    api: apiImpl || (async () => articleDetail({
      body,
      progress: articleProgress
    })),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    tts: useTts ? tts.controller : null,
    progressQueue,
    aloudCheckpointStore: checkpointStore,
    username: 'alice',
    storage: env.window.localStorage,
    progressRuntime: {
      now: () => currentNow,
      setInterval(callback, delay) {
        intervals.push({ callback, delay });
        return intervals.length;
      },
      clearInterval() {},
      requestAnimationFrame: callback => callback()
    },
    mediaRuntime: {
      mediaSession,
      MediaMetadata,
      now: () => currentNow,
      setInterval(callback, delay) {
        intervals.push({ callback, delay });
        return intervals.length;
      },
      clearInterval() {}
    }
  });
  return {
    ...env,
    cleanup,
    speech,
    tts,
    checkpointStore,
    checkpointSaves,
    progressQueue,
    mediaSession,
    timerKey,
    intervals,
    ready: flush,
    setNow(value) { currentNow = value; }
  };
}

test('partial article translation renders completed paragraphs, pending placeholders, and progress', async () => {
  const articleRequest = deferred();
  const detail = articleDetail({ body: 'First paragraph.\n\nSecond paragraph.' });
  const partial = {
    status: 'partial',
    sourceHash: 'a'.repeat(64),
    rulesVersion: 'article-v2-progressive',
    titleZh: '娴嬭瘯鏂囩珷',
    paragraphs: [{ index: 0, translation: '绗竴娈点€?' }],
    batches: [
      { index: 0, paragraphIndexes: [0], completed: true },
      { index: 1, paragraphIndexes: [1], completed: false }
    ],
    completedBatches: 1,
    totalBatches: 2
  };
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return partial;
      if (path === '/api/articles/a1/translation/batches/1' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));

    assert.equal(
      env.root.querySelector('[data-role="paragraph-translation"]').textContent,
      '绗竴娈点€?'
    );
    assert.equal(
      env.root.querySelector('[data-role="paragraph-translation-pending"]')
        .dataset.paragraphIndex,
      '1'
    );
    /* Previous mojibake expectation intentionally removed.
    assert.equal(
      env.root.querySelector('[data-role="article-translation-progress"]').textContent,
      '宸茬炕璇?1/2 鎵?'
    );
    */
    assert.equal(
      env.root.querySelector('[data-role="article-translation-progress"]').getAttribute('role'),
      'status'
    );
    assert.equal(
      env.root.querySelector('[data-role="article-translation-progress"]').textContent,
      '已翻译 1/2 批'
    );
    assert.equal(
      env.root.querySelector('[data-role="article-translation-progress"]')
        .getAttribute('aria-live'),
      'polite'
    );
  } finally {
    env.cleanup();
    articleRequest.resolve(progressiveArticleTranslation([0, 1], 1, { totalBatches: 2 }));
    env.restore();
  }
});

test('reader schedules progressive article batches and resumes only missing work', async () => {
  const requests = new Map([0, 1, 2, 3].map(index => [index, deferred()]));
  const calls = [];
  const detail = articleDetail({
    body: 'Paragraph zero.\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.',
    markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation();
      }
      const match = path.match(/^\/api\/articles\/a1\/translation\/batches\/(\d+)$/);
      if (match && init.method === 'PUT') {
        const index = Number(match[1]);
        calls.push({ index, body: JSON.parse(init.body) });
        return requests.get(index).promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));

    assert.deepEqual(calls, [{
      index: 0,
      body: {
        sourceHash: 'a'.repeat(64),
        rulesVersion: 'article-v2-progressive',
        refresh: false
      }
    }]);

    requests.get(0).resolve(progressiveArticleTranslation([0], 0));
    await waitFor(() => calls.length === 3, 'later translation batches did not start');
    assert.deepEqual(calls.map(call => call.index), [0, 1, 2]);
    assert.equal(
      env.root.querySelector('[data-role="paragraph-translation"][data-paragraph-index="0"]')
        .textContent,
      'translation 0'
    );

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="original"]'
    ));
    requests.get(2).resolve(progressiveArticleTranslation([0, 2], 2));
    await env.ready();
    assert.deepEqual(calls.map(call => call.index), [0, 1, 2]);

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    assert.deepEqual(calls.map(call => call.index), [0, 1, 2, 3]);
    assert.equal(calls.filter(call => call.index === 1).length, 1);
    assert.equal(calls.filter(call => call.index === 2).length, 1);
  } finally {
    env.cleanup();
    for (const request of requests.values()) {
      request.resolve(progressiveArticleTranslation([0, 1, 2, 3]));
    }
    env.restore();
  }
});

test('completed article batches preserve focused and speaking sentence nodes', async () => {
  const gate = deferred();
  const detail = articleDetail({ body: 'Focused sentence.', markings: [], pending_terms: [], words: [] });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 1 });
      }
      if (path.endsWith('/translation/batches/0') && init.method === 'PUT') return gate.promise;
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('[data-action="translation-mode"][data-mode="full"]'));
    const sentence = env.root.querySelector('[data-sentence-index="0"]');
    sentence.tabIndex = -1;
    sentence.classList.add('pc-speaking');
    sentence.focus();
    gate.resolve(progressiveArticleTranslation([0], 0, {
      totalBatches: 1, titleZh: '标题', translations: { 0: '译文。' }
    }));
    await waitFor(() => env.root.querySelector('[data-role="paragraph-translation"]'));
    assert.equal(sentence.isConnected, true);
    assert.equal(env.window.document.activeElement, sentence);
    assert.equal(sentence.classList.contains('pc-speaking'), true);
  } finally {
    env.cleanup();
    gate.resolve(progressiveArticleTranslation([0], 0, { totalBatches: 1 }));
    env.restore();
  }
});

test('full mode immediately renders pending paragraphs before translation resolves', async () => {
  const articleRequest = deferred();
  const detail = articleDetail({ body: 'First paragraph.\n\nSecond paragraph.' });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 2 });
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));

    assert.equal(
      env.root.querySelectorAll('[data-role="paragraph-translation-pending"]').length,
      2
    );
    /* Previous mojibake expectation intentionally removed.
    assert.equal(
      env.root.querySelector('[data-role="paragraph-translation-pending"]').textContent,
      '绛夊緟缈昏瘧'
    );
    */
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'full');
    assert.equal(
      env.root.querySelector('[data-role="paragraph-translation-pending"]').textContent,
      '等待翻译'
    );
  } finally {
    env.cleanup();
    articleRequest.resolve(progressiveArticleTranslation([0], 0, { totalBatches: 2 }));
    env.restore();
  }
});

test('stale article translation success cannot overwrite a newer loaded state', async () => {
  const articleRequest = deferred();
  let translationGets = 0;
  const detail = articleDetail({ words: [] });
  const newerTranslation = {
    status: 'fresh', titleZh: 'new-title', paragraphs: [
      { index: 0, translation: 'new-first' },
      { index: 1, translation: 'new-second' }
    ]
  };
  const env = setupReader({
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        translationGets += 1;
        return translationGets === 1
          ? progressiveArticleTranslation([], null, { totalBatches: 2 })
          : newerTranslation;
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      if (path === '/api/articles/a1/markings/m1' && init.method === 'DELETE') {
        return { ok: true };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('.pc-term-pending'));
    click(env.window, env.root.querySelector('[data-action="unmark-local"]'));
    await waitFor(
      () => env.root.querySelector('[data-role="article-translation-title"]')
        ?.textContent === 'new-title',
      'newer translation state was not loaded'
    );

    articleRequest.resolve({
      status: 'fresh', titleZh: 'old-title', paragraphs: [
        { index: 0, translation: 'old-first' },
        { index: 1, translation: 'old-second' }
      ]
    });
    await env.ready();

    assert.equal(
      env.root.querySelector('[data-role="article-translation-title"]').textContent,
      'new-title'
    );
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="paragraph-translation"]')]
        .map(node => node.textContent),
      ['new-first', 'new-second']
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('article translation state GET failure can recover in-reader without reload', async () => {
  let gets = 0;
  const detail = articleDetail({ body: 'Recoverable paragraph.', markings: [], pending_terms: [], words: [] });
  const env = setupReader({
    body: detail.body,
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        gets += 1;
        if (gets === 1) throw new Error('state unavailable');
        return progressiveArticleTranslation([0], null, {
          totalBatches: 1, titleZh: '标题', translations: { 0: '已恢复。' }
        });
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'full');
    const retry = env.root.querySelector('[data-action="retry-article-translation-state"]');
    assert.ok(retry);
    click(env.window, retry);
    await waitFor(
      () => env.root.querySelector('[data-role="paragraph-translation"]')?.textContent === '已恢复。'
    );
    assert.equal(gets, 2);
    assert.equal(env.root.querySelector(':scope > [data-inline-error]'), null);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('switching original to full preserves translation-state retry and recovers', async () => {
  let gets = 0;
  const detail = articleDetail({ body: 'Retry after mode switch.', markings: [], pending_terms: [], words: [] });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        gets += 1;
        if (gets === 1) throw new Error('state unavailable');
        return progressiveArticleTranslation([0], null, {
          totalBatches: 1, titleZh: '标题', translations: { 0: '恢复译文。' }
        });
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('[data-action="translation-mode"][data-mode="full"]'));
    const retry = env.root.querySelector('[data-action="retry-article-translation-state"]');
    assert.ok(retry);
    click(env.window, retry);
    await waitFor(
      () => env.root.querySelector('[data-role="paragraph-translation"]')?.textContent === '恢复译文。'
    );
    assert.equal(gets, 2);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('source and rules conflicts reload authoritative translation state', async () => {
  for (const code of ['TRANSLATION_SOURCE_CHANGED', 'TRANSLATION_RULES_CHANGED']) {
    let gets = 0;
    let puts = 0;
    const detail = articleDetail({ body: 'Conflict paragraph.', markings: [], pending_terms: [], words: [] });
    const env = setupReader({
      body: detail.body,
      apiImpl: async (path, init = {}) => {
        if (path === '/api/articles/a1' && !init.method) return detail;
        if (path === '/api/articles/a1/translation' && !init.method) {
          gets += 1;
          return gets === 1
            ? progressiveArticleTranslation([], null, { totalBatches: 1 })
            : progressiveArticleTranslation([0], null, {
              totalBatches: 1, titleZh: '新标题', translations: { 0: `恢复 ${code}` }
            });
        }
        if (path.endsWith('/translation/batches/0') && init.method === 'PUT') {
          puts += 1;
          const error = new Error(code);
          error.code = code;
          throw error;
        }
        throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
      }
    });
    try {
      await env.ready();
      click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
      click(env.window, env.root.querySelector('[data-action="translation-mode"][data-mode="full"]'));
      await waitFor(() => env.root.querySelector('[data-role="paragraph-translation"]'));
      assert.equal(gets, 2);
      assert.equal(puts, 1);
      assert.equal(env.root.querySelector(':scope > [data-inline-error]'), null);
    } finally {
      env.cleanup();
      env.restore();
    }
  }
});

test('stale article translation failure stays silent after a newer load resets mode', async () => {
  const articleRequest = deferred();
  let translationGets = 0;
  const detail = articleDetail({ words: [] });
  const env = setupReader({
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        translationGets += 1;
        return translationGets === 1
          ? progressiveArticleTranslation([], null, { totalBatches: 2 })
          : { status: 'missing', sourceHash: 'b'.repeat(64), rulesVersion: 'article-v2-progressive' };
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      if (path === '/api/articles/a1/markings/m1' && init.method === 'DELETE') {
        return { ok: true };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('.pc-term-pending'));
    click(env.window, env.root.querySelector('[data-action="unmark-local"]'));
    await waitFor(
      () => env.window.localStorage.getItem(TRANSLATION_MODE_KEY) === 'original',
      'newer load did not reset translation mode'
    );

    articleRequest.reject(new Error('obsolete generation failed'));
    await env.ready();

    assert.equal(env.root.querySelector(':scope > [data-inline-error]'), null);
    assert.equal(
      env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'),
      'false'
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('article translation settlement does not restore focus after the panel loses ownership', async () => {
  const articleRequest = deferred();
  const env = setupReader({
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 2 });
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    const back = env.root.querySelector('[data-action="back-library"]');
    back.focus();

    articleRequest.resolve({
      status: 'fresh', titleZh: '娴嬭瘯鏍囬', paragraphs: [
        { index: 0, translation: '绗竴娈点€?' },
        { index: 1, translation: '绗簩娈点€?' }
      ]
    });
    await env.ready();

    assert.equal(env.window.document.activeElement, back);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation toolbar panel generates and toggles complete paragraph translations', async () => {
  const calls = [];
  const detail = articleDetail({ body: 'First paragraph.\n\nSecond paragraph.' });
  const translation = {
    status: 'fresh', titleZh: '测试文章', model: '@cf/zai-org/glm-4.7-flash',
    updatedAt: 2,
    sourceHash: 'a'.repeat(64), rulesVersion: 'article-v2-progressive',
    paragraphs: [
      { index: 0, translation: '第一段。' },
      { index: 1, translation: '第二段。' }
    ],
    batches: [{ index: 0, paragraphIndexes: [0, 1], completed: true }],
    completedBatches: 1, totalBatches: 1, completedBatch: 0
  };
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      calls.push({ path, init });
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return {
        ...translation, status: 'missing', titleZh: '', paragraphs: [],
        batches: [{ index: 0, paragraphIndexes: [0, 1], completed: false }],
        completedBatches: 0, completedBatch: undefined
      };
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return translation;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    let trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-label'), '翻译');
    assert.equal(trigger.nextElementSibling?.dataset.action, 'reader-settings');
    assert.equal(env.root.querySelector('.pc-reader-translation-controls'), null);

    click(env.window, trigger);
    const panel = env.root.querySelector('[data-role="translation-panel"]');
    assert.ok(panel);
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.deepEqual(
      [...panel.querySelectorAll('[data-action="translation-mode"]')].map(node => node.dataset.mode),
      ['original', 'sentence', 'full']
    );
    click(env.window, panel.querySelector('[data-action="translation-mode"][data-mode="full"]'));
    await env.ready();

    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="paragraph-translation"]')]
        .map(node => node.textContent),
      ['第一段。', '第二段。']
    );
    const translatedTitle = env.root.querySelector('[data-role="article-translation-title"]');
    assert.equal(translatedTitle.textContent, '测试文章');
    assert.ok(translatedTitle.previousElementSibling.matches('.pc-reader-title'));
    trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.equal(trigger.getAttribute('aria-pressed'), 'true');
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'full');
    assert.ok(calls.some(call => (
      call.path === '/api/articles/a1/translation/batches/0' && initMethod(call) === 'PUT'
    )));

    click(env.window, trigger);
    click(env.window, env.root.querySelector('[data-action="translation-mode"][data-mode="original"]'));
    assert.equal(env.root.querySelector('[data-role="article-translation-title"]'), null);
    assert.equal(env.root.querySelector('[data-role="paragraph-translation"]'), null);
    assert.equal(env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'), 'false');
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'original');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation panel restores focus and persists sentence mode without rendering full translation', async () => {
  const env = setupReader({
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) return {
        status: 'fresh', titleZh: '已保存标题', model: 'model', updatedAt: 2,
        paragraphs: [{ index: 0, translation: '已保存译文。' }]
      };
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    let trigger = env.root.querySelector('[data-action="translation-menu"]');
    trigger.focus();
    click(env.window, trigger);
    let panel = env.root.querySelector('[data-role="translation-panel"]');
    assert.equal(
      env.window.document.activeElement,
      panel.querySelector('[data-action="translation-mode"][data-mode="original"]')
    );

    click(env.window, panel.querySelector('[data-action="translation-mode"][data-mode="sentence"]'));
    trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.equal(env.window.document.activeElement, trigger);
    assert.equal(trigger.getAttribute('aria-pressed'), 'true');
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'sentence');
    assert.equal(env.root.querySelector('[data-role="article-translation-title"]'), null);
    assert.equal(env.root.querySelector('[data-role="paragraph-translation"]'), null);

    trigger.focus();
    click(env.window, trigger);
    click(env.window, env.window.document.body);
    assert.equal(env.root.querySelector('[data-role="translation-panel"]'), null);
    assert.equal(env.window.document.activeElement, trigger);

    click(env.window, trigger);
    panel = env.root.querySelector('[data-role="translation-panel"]');
    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(panel.isConnected, false);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation restoration falls back to original without an AI request when full is missing', async () => {
  let aiPutCalls = 0;
  const env = setupReader({
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/translation' && init.method === 'PUT') {
        aiPutCalls += 1;
        throw new Error('must not generate');
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    assert.equal(aiPutCalls, 0);
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'original');
    assert.equal(env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'), 'false');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation restoration displays an existing full translation without an AI request', async () => {
  let aiPutCalls = 0;
  const translation = {
    status: 'fresh', titleZh: '已有标题', model: 'model', updatedAt: 2,
    paragraphs: [{ index: 0, translation: '已有译文。' }]
  };
  const env = setupReader({
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) return translation;
      if (path === '/api/articles/a1/translation' && init.method === 'PUT') {
        aiPutCalls += 1;
        return translation;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    assert.equal(aiPutCalls, 0);
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'full');
    assert.equal(env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'), 'true');
    assert.equal(env.root.querySelector('[data-role="article-translation-title"]').textContent, '已有标题');
    assert.equal(env.root.querySelector('[data-role="paragraph-translation"]').textContent, '已有译文。');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('failed first progressive batch keeps full mode active without trapping focus', async () => {
  const articleRequest = deferred();
  const env = setupReader({
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 2 });
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    const full = env.root.querySelector('[data-action="translation-mode"][data-mode="full"]');
    full.focus();
    click(env.window, full);

    let trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.equal(full.isConnected, false);
    assert.equal(env.root.querySelector('[data-role="translation-panel"]'), null);
    assert.equal(env.window.document.activeElement, trigger);
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'full');

    articleRequest.reject(new Error('generation failed'));
    await env.ready();
    assert.match(env.root.querySelector(':scope > [data-inline-error]').textContent, /generation failed/);
    assert.equal(env.window.document.activeElement, trigger);
    assert.equal(trigger.getAttribute('aria-pressed'), 'true');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation mode refresh failure preserves the existing full translation and display mode', async () => {
  const refreshRequest = deferred();
  const translation = progressiveArticleTranslation([0], null, {
    totalBatches: 1,
    titleZh: '旧标题',
    translations: { 0: '旧译文。' }
  });
  const env = setupReader({
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) return translation;
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return refreshRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    const refresh = env.root.querySelector('[data-action="translate-article"]');
    refresh.focus();
    click(env.window, refresh);

    const trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.equal(refresh.isConnected, false);
    assert.equal(env.root.querySelector('[data-role="translation-panel"]'), null);
    assert.equal(env.window.document.activeElement, trigger);
    assert.equal(env.root.querySelector('[data-role="paragraph-translation"]').textContent, '旧译文。');

    refreshRequest.reject(new Error('refresh failed'));
    await env.ready();

    assert.equal(env.root.querySelector('[data-role="article-translation-title"]').textContent, '旧标题');
    assert.equal(env.root.querySelector('[data-role="paragraph-translation"]').textContent, '旧译文。');
    assert.equal(env.window.localStorage.getItem(TRANSLATION_MODE_KEY), 'full');
    assert.equal(env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'), 'true');
    assert.match(env.root.querySelector(':scope > [data-inline-error]').textContent, /refresh failed/);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation panel remains usable while the first progressive batch is in flight', async () => {
  const articleRequest = deferred();
  const env = setupReader({
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 2 });
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    let trigger = env.root.querySelector('[data-action="translation-menu"]');
    click(env.window, trigger);
    const full = env.root.querySelector('[data-action="translation-mode"][data-mode="full"]');
    full.focus();
    click(env.window, full);

    trigger = env.root.querySelector('[data-action="translation-menu"]');
    click(env.window, trigger);
    const reopened = env.root.querySelector('[data-role="translation-panel"]');
    const currentFull = reopened.querySelector('[data-action="translation-mode"][data-mode="full"]');
    assert.equal(env.window.document.activeElement, currentFull);
    assert.ok([...reopened.querySelectorAll('[data-action="translation-mode"]')]
      .every(node => node.disabled === false));

    articleRequest.reject(new Error('generation failed'));
    await env.ready();
    assert.equal(currentFull.isConnected, true);
    assert.equal(currentFull.disabled, false);
    assert.equal(env.window.document.activeElement, currentFull);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('translation panel remains usable while a full refresh is in flight', async () => {
  const refreshRequest = deferred();
  const translation = progressiveArticleTranslation([0], null, {
    totalBatches: 1,
    titleZh: '旧标题',
    translations: { 0: '旧译文。' }
  });
  const env = setupReader({
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail();
      if (path === '/api/articles/a1/translation' && !init.method) return translation;
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return refreshRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    let trigger = env.root.querySelector('[data-action="translation-menu"]');
    click(env.window, trigger);
    const refresh = env.root.querySelector('[data-action="translate-article"]');
    refresh.focus();
    click(env.window, refresh);

    trigger = env.root.querySelector('[data-action="translation-menu"]');
    click(env.window, trigger);
    const reopened = env.root.querySelector('[data-role="translation-panel"]');
    const currentRefresh = reopened.querySelector('[data-action="translate-article"]');
    assert.equal(currentRefresh.disabled, false);

    refreshRequest.reject(new Error('refresh failed'));
    await env.ready();
    assert.equal(currentRefresh.isConnected, true);
    assert.equal(currentRefresh.disabled, false);
    assert.match(env.root.querySelector(':scope > [data-inline-error]').textContent, /refresh failed/);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation slot renders immediately and keeps sentence speech separate', async () => {
  const restoreRequest = deferred();
  const posts = [];
  const detail = articleDetail({
    body: 'First sentence. Second sentence.', markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    articleProgress: { last_position_ratio: 0, last_aloud_sentence_index: null },
    useTts: false,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) {
        return restoreRequest.promise;
      }
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push(body);
        return { ...body, translation: '第一句。', cached: false };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    assert.ok([...env.root.querySelectorAll('.pc-reader-paragraph')]
      .every(node => node.tagName === 'P'));

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="sentence"]'
    ));

    const sentence = env.root.querySelector('.pc-reader-sentence[data-sentence-index="0"]');
    let slot = env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="0"]'
    );
    assert.ok(slot, 'sentence slots should render before cache restoration settles');
    assert.equal(slot.dataset.state, 'idle');
    assert.equal(slot.closest('.pc-reader-sentence-unit').firstElementChild, sentence);
    assert.equal(slot.closest('.pc-reader-paragraph').tagName, 'DIV');
    assert.ok(slot.closest('.pc-reader-paragraph').classList.contains(
      'pc-reader-paragraph-sentence-mode'
    ));
    const idleAction = slot.querySelector('[data-action="translate-sentence"]');
    assert.equal(
      idleAction.querySelector('.pc-sentence-translation-glyph')?.textContent,
      '译'
    );
    assert.equal(
      idleAction.querySelector('.pc-sentence-translation-action-label')?.textContent,
      '翻译本句'
    );

    click(env.window, sentence);
    assert.deepEqual(env.speech.calls.at(-1), ['speakOnce', 'First sentence. ']);
    assert.equal(posts.length, 0, 'speaking English must not request a translation');

    restoreRequest.resolve({ sentences: [] });
    await env.ready();
    slot = env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="0"]'
    );
    const slotHeightBefore = slot.getBoundingClientRect().height;
    slot.querySelector('[data-action="translate-sentence"]').focus();
    click(env.window, slot.querySelector('[data-action="translate-sentence"]'));
    assert.equal(slot.dataset.state, 'loading');
    assert.equal(
      env.window.document.activeElement,
      slot.querySelector('[data-role="sentence-translation-status"]')
    );
    await waitFor(
      () => posts.length === 1 && slot.dataset.state === 'translated',
      'sentence POST should reach translated state'
    );

    slot = env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="0"]'
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0].sentenceIndex, 0);
    assert.equal(posts[0].refresh, false);
    assert.match(posts[0].sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(slot.dataset.state, 'translated');
    assert.equal(slot.getBoundingClientRect().height, slotHeightBefore);
    const translated = slot.querySelector('[data-role="sentence-translation"]');
    assert.equal(translated.textContent, '第一句。');
    assert.equal(translated.tagName, 'SPAN');
    assert.notEqual(translated.parentElement.tagName, 'BUTTON');
    const refreshAction = slot.querySelector('[data-action="refresh-sentence-translation"]');
    assert.equal(env.window.document.activeElement, refreshAction);
    assert.ok(refreshAction.classList.contains('pc-sentence-translation-refresh'));
    assert.ok(refreshAction.querySelector('svg'));
    assert.equal(
      refreshAction.getAttribute('aria-label'),
      '重新翻译'
    );
    assert.equal(slot.querySelector('button p'), null);
    assert.equal(slot.querySelectorAll('button').length, 1);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation restore hydrates returned indexes once and survives full mode', async () => {
  let sentenceGets = 0;
  let sentencePosts = 0;
  const detail = articleDetail({
    body: 'First sentence. Second sentence.', markings: [], pending_terms: [], words: []
  });
  const fullTranslation = {
    status: 'fresh', titleZh: '全文', model: 'model', updatedAt: 2,
    paragraphs: [{ index: 0, translation: '全文译文。' }]
  };
  const secondSourceHash = await translationSourceHash('Second sentence.');
  const paragraphContextHash = await translationSourceHash(detail.body);
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return fullTranslation;
      if (path === '/api/articles/a1/sentence-translations' && !init.method) {
        sentenceGets += 1;
        return {
          sentences: [{
            sentenceIndex: 1,
            sourceHash: secondSourceHash,
            contextHash: paragraphContextHash,
            translation: '第二句。'
          }]
        };
      }
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        sentencePosts += 1;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    await waitFor(
      () => env.root.querySelector('[data-role="sentence-translation"]'),
      'matching sentence cache should hydrate'
    );
    assert.equal(sentenceGets, 1);
    assert.equal(sentencePosts, 0);
    assert.equal(env.root.querySelectorAll('[data-role="sentence-translation-slot"]').length, 2);
    assert.equal(env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="0"]'
    ).dataset.state, 'idle');
    assert.equal(env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="1"] '
      + '[data-role="sentence-translation"]'
    ).textContent, '第二句。');

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    assert.equal(env.root.querySelector('[data-role="sentence-translation-slot"]'), null);
    assert.ok([...env.root.querySelectorAll('.pc-reader-paragraph')]
      .every(node => node.tagName === 'P'));

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="sentence"]'
    ));
    assert.equal(sentenceGets, 1);
    assert.equal(env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="1"] '
      + '[data-role="sentence-translation"]'
    ).textContent, '第二句。');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation restore failure leaves idle slots usable', async () => {
  let posts = 0;
  const detail = articleDetail({
    body: 'First sentence.', markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) {
        throw new Error('cache unavailable');
      }
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        posts += 1;
        const body = JSON.parse(init.body);
        return { ...body, translation: '仍可翻译。', cached: false };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    assert.match(env.root.querySelector('[data-role="reader-error"]').textContent, /cache unavailable/);
    let slot = env.root.querySelector('[data-role="sentence-translation-slot"]');
    assert.equal(slot.dataset.state, 'idle');
    click(env.window, slot.querySelector('[data-action="translate-sentence"]'));
    await waitFor(
      () => posts === 1 && slot.dataset.state === 'translated',
      'translation after cache failure should reach translated state'
    );
    slot = env.root.querySelector('[data-role="sentence-translation-slot"]');
    assert.equal(posts, 1);
    assert.equal(slot.dataset.state, 'translated');
    assert.equal(slot.querySelector('[data-role="sentence-translation"]').textContent, '仍可翻译。');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation slot isolates loading, errors, and retries', async () => {
  const firstRequest = deferred();
  const secondRequest = deferred();
  const attempts = new Map();
  const detail = articleDetail({
    body: 'First sentence. Second sentence.', markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) return { sentences: [] };
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        attempts.set(body.sentenceIndex, (attempts.get(body.sentenceIndex) || 0) + 1);
        if (body.sentenceIndex === 0 && attempts.get(0) === 1) return firstRequest.promise;
        if (body.sentenceIndex === 1 && attempts.get(1) === 1) {
          return secondRequest.promise.then(() => ({
            ...body,
            translation: '第二句。',
            cached: false
          }));
        }
        return {
          ...body,
          translation: body.sentenceIndex === 0 ? '第一句重试。' : '第二句。',
          cached: false
        };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    let slots = env.root.querySelectorAll('[data-role="sentence-translation-slot"]');
    slots[0].querySelector('[data-action="translate-sentence"]').focus();
    click(env.window, slots[0].querySelector('[data-action="translate-sentence"]'));
    assert.equal(slots[0].dataset.state, 'loading');
    assert.equal(
      env.window.document.activeElement,
      slots[0].querySelector('[data-role="sentence-translation-status"]')
    );
    assert.equal(slots[1].dataset.state, 'idle');
    assert.equal(slots[1].querySelector('[data-action="translate-sentence"]').disabled, false);

    click(env.window, slots[1].querySelector('[data-action="translate-sentence"]'));
    await waitFor(
      () => attempts.get(0) === 1 && attempts.get(1) === 1,
      'both sentence POST requests should start independently'
    );
    secondRequest.resolve();
    await waitFor(
      () => slots[1].dataset.state === 'translated',
      'resolved independent sentence POST should reach translated state'
    );
    firstRequest.reject(new Error('first sentence failed'));
    await waitFor(
      () => slots[0].dataset.state === 'error',
      'rejected sentence POST should reach error state'
    );
    slots = env.root.querySelectorAll('[data-role="sentence-translation-slot"]');
    assert.equal(slots[0].dataset.state, 'error');
    assert.match(slots[0].textContent, /first sentence failed/);
    assert.ok(slots[0].querySelector('[data-action="translate-sentence"]'));
    assert.equal(
      env.window.document.activeElement,
      slots[0].querySelector('[data-action="translate-sentence"]')
    );
    assert.equal(slots[1].querySelector('[data-role="sentence-translation"]').textContent, '第二句。');

    click(env.window, slots[0].querySelector('[data-action="translate-sentence"]'));
    await waitFor(
      () => attempts.get(0) === 2 && slots[0].dataset.state === 'translated',
      'sentence retry should reach translated state'
    );
    assert.equal(env.root.querySelector(
      '[data-role="sentence-translation-slot"][data-sentence-index="0"] '
      + '[data-role="sentence-translation"]'
    ).textContent, '第一句重试。');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation refresh preserves the old value on failure', async () => {
  const failedRefresh = deferred();
  const bodies = [];
  const detail = articleDetail({
    body: 'First sentence.', markings: [], pending_terms: [], words: []
  });
  const sourceHash = await translationSourceHash(detail.body);
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) return {
        sentences: [{
          sentenceIndex: 0,
          sourceHash,
          contextHash: sourceHash,
          translation: '旧译文。'
        }]
      };
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (bodies.length === 1) return failedRefresh.promise;
        return { ...body, translation: '新译文。', cached: false };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    await waitFor(
      () => env.root.querySelector('[data-action="refresh-sentence-translation"]'),
      'cached sentence should hydrate before refresh'
    );
    let slot = env.root.querySelector('[data-role="sentence-translation-slot"]');
    slot.querySelector('[data-action="refresh-sentence-translation"]').focus();
    click(env.window, slot.querySelector('[data-action="refresh-sentence-translation"]'));
    slot = env.root.querySelector('[data-role="sentence-translation-slot"]');
    assert.equal(slot.dataset.state, 'loading');
    assert.equal(slot.querySelector('[data-role="sentence-translation"]').textContent, '旧译文。');
    assert.equal(
      env.window.document.activeElement,
      slot.querySelector('[data-role="sentence-translation-status"]')
    );
    await waitFor(() => bodies.length === 1, 'refresh POST should start before rejection');
    failedRefresh.reject(new Error('refresh failed'));
    await waitFor(
      () => slot.dataset.state === 'error',
      'failed refresh should reach error state'
    );

    slot = env.root.querySelector('[data-role="sentence-translation-slot"]');
    assert.equal(bodies[0].refresh, true);
    assert.equal(slot.dataset.state, 'error');
    assert.equal(slot.querySelector('[data-role="sentence-translation"]').textContent, '旧译文。');
    assert.match(slot.textContent, /refresh failed/);
    assert.equal(
      env.window.document.activeElement,
      slot.querySelector('[data-action="refresh-sentence-translation"]')
    );
    click(env.window, slot.querySelector('[data-action="refresh-sentence-translation"]'));
    await waitFor(
      () => bodies.length === 2 && slot.dataset.state === 'translated',
      'refresh retry should reach translated state'
    );
    assert.equal(bodies[1].refresh, true);
    assert.equal(env.root.querySelector('[data-role="sentence-translation"]').textContent, '新译文。');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation stale responses cannot replace newer state or mutate after cleanup', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  let postCount = 0;
  const detail = articleDetail({
    body: 'First sentence.', markings: [], pending_terms: [], words: []
  });
  const cachedSourceHash = await translationSourceHash(detail.body);
  const apiImpl = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) return detail;
    if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
    if (path === '/api/articles/a1/sentence-translations' && !init.method) return {
      sentences: [{
        sentenceIndex: 0,
        sourceHash: cachedSourceHash,
        contextHash: cachedSourceHash,
        translation: 'cached'
      }]
    };
    if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
      postCount += 1;
      return postCount === 1 ? oldRequest.promise : newRequest.promise;
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const env = setupReader({ body: detail.body, translationMode: 'sentence', apiImpl });
  try {
    await waitFor(
      () => env.root.querySelector('[data-action="refresh-sentence-translation"]'),
      'cached sentence should hydrate before stale-response checks'
    );
    click(env.window, env.root.querySelector('[data-action="refresh-sentence-translation"]'));
    await waitFor(() => postCount === 1, 'older refresh POST should start before mode switch');
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="original"]'
    ));
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="sentence"]'
    ));
    click(env.window, env.root.querySelector('[data-action="refresh-sentence-translation"]'));
    await waitFor(() => postCount === 2, 'newer refresh POST should start before resolution');
    assert.equal(postCount, 2);

    newRequest.resolve({
      sentenceIndex: 0, sourceHash: 'b'.repeat(64), translation: 'newest', cached: false
    });
    await env.ready();
    oldRequest.resolve({
      sentenceIndex: 0, sourceHash: 'a'.repeat(64), translation: 'stale', cached: false
    });
    await env.ready();
    assert.equal(env.root.querySelector('[data-role="sentence-translation"]').textContent, 'newest');
  } finally {
    env.cleanup();
    env.restore();
  }

  const cleanupRequest = deferred();
  let cleanupPostStarted = false;
  const cleanupEnv = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) return { sentences: [] };
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        cleanupPostStarted = true;
        return cleanupRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await cleanupEnv.ready();
    click(cleanupEnv.window, cleanupEnv.root.querySelector('[data-action="translate-sentence"]'));
    await waitFor(() => cleanupPostStarted, 'cleanup POST should start before unmount');
    const htmlAtCleanup = cleanupEnv.root.innerHTML;
    cleanupEnv.cleanup();
    cleanupRequest.resolve({
      sentenceIndex: 0, sourceHash: 'c'.repeat(64), translation: 'too late', cached: false
    });
    await cleanupEnv.ready();
    assert.equal(cleanupEnv.root.innerHTML, htmlAtCleanup);
  } finally {
    cleanupEnv.cleanup();
    cleanupEnv.restore();
  }
});

test('sentence translation restore rejects sentence or paragraph hash mismatches', async () => {
  const detail = articleDetail({
    body: 'First sentence. Second sentence.', markings: [], pending_terms: [], words: []
  });
  const paragraphHash = await translationSourceHash(detail.body);
  const secondHash = await translationSourceHash('Second sentence.');
  const wrongContextHash = await translationSourceHash('Different paragraph.');
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) return {
        sentences: [
          {
            sentenceIndex: 0,
            sourceHash: secondHash,
            contextHash: paragraphHash,
            translation: 'wrong sentence'
          },
          {
            sentenceIndex: 1,
            sourceHash: secondHash,
            contextHash: wrongContextHash,
            translation: 'wrong context'
          }
        ]
      };
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await waitFor(
      () => env.root.querySelectorAll('[data-role="sentence-translation-slot"]').length === 2,
      'sentence slots should render'
    );
    await env.ready();
    const slots = env.root.querySelectorAll('[data-role="sentence-translation-slot"]');
    assert.deepEqual([...slots].map(slot => slot.dataset.state), ['idle', 'idle']);
    assert.equal(env.root.querySelector('[data-role="sentence-translation"]'), null);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation restore discards hashing that finishes after leaving sentence mode', async () => {
  const detail = articleDetail({
    body: 'First sentence.', markings: [], pending_terms: [], words: []
  });
  const sourceHash = await translationSourceHash(detail.body);
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  const gate = deferred();
  let gets = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      ...nativeCrypto,
      subtle: {
        digest: async (...args) => {
          await gate.promise;
          return nativeCrypto.subtle.digest(...args);
        }
      }
    }
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) {
        gets += 1;
        return gets === 1 ? {
          sentences: [{
            sentenceIndex: 0, sourceHash, contextHash: sourceHash, translation: 'stale restore'
          }]
        } : { sentences: [] };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    await waitFor(() => gets === 1, 'initial sentence cache restore should start');
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="original"]'
    ));
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="sentence"]'
    ));
    await waitFor(
      () => gets === 2,
      'returning to sentence mode should reload discarded cache',
      500
    );
    gate.resolve();
    await env.ready();
    assert.equal(env.root.querySelector('[data-role="sentence-translation"]'), null);
  } finally {
    gate.resolve();
    await env.ready();
    env.cleanup();
    env.restore();
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
      delete globalThis.crypto;
    }
  }
});

test('sentence translation restore failure stays silent after leaving sentence mode', async () => {
  const restoreRequest = deferred();
  let restoreStarted = false;
  const detail = articleDetail({
    body: 'First sentence.', markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) {
        restoreStarted = true;
        return restoreRequest.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await waitFor(() => restoreStarted, 'sentence cache restore should start');
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="original"]'
    ));
    restoreRequest.reject(new Error('late cache failure'));
    await env.ready();
    assert.equal(env.root.querySelector('[data-role="reader-error"]'), null);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sentence translation shows an immediate offline state without hashing or fetching', async () => {
  const detail = articleDetail({ body: 'First sentence.', markings: [], pending_terms: [], words: [] });
  const sourceHash = await translationSourceHash(detail.body);
  let posts = 0;
  const env = setupReader({
    body: detail.body,
    translationMode: 'sentence',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/articles/a1/sentence-translations' && !init.method) return {
        sentences: [{
          sentenceIndex: 0,
          sourceHash,
          contextHash: sourceHash,
          translation: '保留的旧译文。'
        }]
      };
      if (path === '/api/articles/a1/sentence-translations' && init.method === 'POST') {
        posts += 1;
        throw new Error('must not fetch offline');
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await waitFor(
      () => env.root.querySelector('[data-action="refresh-sentence-translation"]'),
      'cached translation should hydrate before going offline'
    );
    Object.defineProperty(env.window.navigator, 'onLine', { configurable: true, value: false });
    const slot = env.root.querySelector('[data-role="sentence-translation-slot"]');
    slot.querySelector('[data-action="refresh-sentence-translation"]').focus();
    click(env.window, slot.querySelector('[data-action="refresh-sentence-translation"]'));
    assert.equal(posts, 0);
    assert.equal(slot.dataset.state, 'offline');
    assert.match(slot.textContent, /需要联网/);
    assert.equal(slot.querySelector('[data-role="sentence-translation"]').textContent, '保留的旧译文。');
    assert.equal(
      env.window.document.activeElement,
      slot.querySelector('[data-action="refresh-sentence-translation"]')
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('selection panel translates only the selection with its complete sentence context', async () => {
  const requests = [];
  const detail = articleDetail({
    body: 'After three failed attempts, she finally nailed it.',
    markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return { status: 'missing' };
      if (path === '/api/translations/selection') {
        requests.push(JSON.parse(init.body));
        return { translation: '搞定了' };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    const sentence = env.root.querySelector('[data-sentence-index="0"]');
    env.window.getSelection = () => validSelection(sentence, { text: 'nailed it' });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="translate-selection"]'));
    await env.ready();

    assert.deepEqual(requests, [{
      text: 'nailed it',
      context: 'After three failed attempts, she finally nailed it.'
    }]);
    assert.equal(
      env.root.querySelector('[data-role="selection-translation"]').textContent,
      '搞定了'
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('selection translation cannot supersede an in-flight article translation', async () => {
  const articleRequest = deferred();
  const detail = articleDetail({
    body: 'First sentence. Second sentence.', markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 1 });
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        return articleRequest.promise;
      }
      if (path === '/api/translations/selection') return { translation: '第一句。' };
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    const articleButton = env.root.querySelector('[data-action="translation-mode"][data-mode="full"]');
    click(env.window, articleButton);
    assert.equal(env.root.querySelector('[data-role="translation-panel"]'), null);
    assert.equal(
      env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'),
      'true'
    );

    const sentence = env.root.querySelector('[data-sentence-index="0"]');
    env.window.getSelection = () => validSelection(sentence, { text: 'First sentence.' });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="translate-selection"]'));
    await flush();

    articleRequest.resolve({
      status: 'fresh', titleZh: '测试', model: '@cf/zai-org/glm-4.7-flash', updatedAt: 2,
      paragraphs: [{ index: 0, translation: '第一句。第二句。' }]
    });
    await env.ready();

    assert.equal(env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'), 'true');
    assert.equal(
      env.root.querySelector('[data-role="paragraph-translation"]').textContent,
      '第一句。第二句。'
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

function initMethod(call) {
  return call.init?.method || 'GET';
}

test('reader prefers a matching local offset and resumes it on user action', async () => {
  const env = setupReader({
    articleProgress: {
      last_position_ratio: 0,
      last_aloud_sentence_index: 0,
      last_aloud_offset_seconds: 1
    },
    checkpoint: {
      sentenceIndex: 1,
      offsetSeconds: 2.5,
      state: 'paused'
    }
  });
  try {
    await env.ready();
    assert.match(
      env.root.querySelector('[data-role="aloud-resume-entry"]').textContent,
      /第 2 句/
    );
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    assert.deepEqual(env.tts.starts.at(-1), {
      articleId: 'a1', startIndex: 1, offsetSeconds: 2.5, profile: 'aria-narration'
    });
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader keeps a matching live player position ahead of local and server progress', async () => {
  const env = setupReader({
    articleProgress: {
      last_position_ratio: 0,
      last_aloud_sentence_index: 0,
      last_aloud_offset_seconds: 0.25
    },
    checkpoint: {
      sentenceIndex: 1,
      offsetSeconds: 0.75,
      state: 'paused'
    },
    liveSnapshot: {
      state: 'paused',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 2,
      currentTime: 1.5
    }
  });
  try {
    await env.ready();
    const resumeState = {
      source: env.tts.controller.getSnapshot().articleId === 'a1' ? 'live' : 'other',
      position: {
        sentenceIndex: env.tts.controller.getSnapshot().currentIndex,
        offsetSeconds: env.tts.controller.getSnapshot().currentTime
      }
    };
    assert.equal(resumeState.source, 'live');
    assert.deepEqual(resumeState.position, { sentenceIndex: 2, offsetSeconds: 1.5 });

    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    assert.equal(env.tts.calls.at(-1), 'resume');
    assert.equal(env.tts.starts.length, 0);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader rejects a mismatched body checkpoint and resumes server position', async () => {
  const env = setupReader({
    body: 'Changed first. Changed second. Changed third.',
    checkpointBody: 'Old first. Old second. Old third.',
    articleProgress: {
      last_position_ratio: 0,
      last_aloud_sentence_index: 1,
      last_aloud_offset_seconds: 0.75
    },
    checkpoint: {
      sentenceIndex: 2,
      offsetSeconds: 3.5,
      state: 'paused'
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    const started = env.tts.starts.at(-1);
    const fingerprintMismatchResume = {
      source: started.startIndex === 1 ? 'server' : 'local',
      position: {
        sentenceIndex: started.startIndex,
        offsetSeconds: started.offsetSeconds
      }
    };
    assert.equal(fingerprintMismatchResume.source, 'server');
    assert.deepEqual(fingerprintMismatchResume.position, {
      sentenceIndex: 1, offsetSeconds: 0.75
    });
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader checkpoints state changes immediately and throttles time updates', async () => {
  const env = setupReader({
    articleProgress: { last_position_ratio: 0 }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    const checkpointSavesAfterStart = env.checkpointSaves.length;
    env.setNow(1_500);
    env.tts.emit({ state: 'speaking', currentIndex: 0, currentTime: 1.5 });
    const checkpointSavesWithinTwoSeconds = env.checkpointSaves.length;
    env.tts.controller.pause();
    const checkpointSavesAfterPause = env.checkpointSaves.length;

    assert.equal(checkpointSavesAfterStart, 1);
    assert.equal(checkpointSavesWithinTwoSeconds, 1);
    assert.equal(checkpointSavesAfterPause, 2);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('pause marker appears only after an actual pause and not during sentence changes', async () => {
  const env = setupReader({
    articleProgress: {
      last_position_ratio: 0,
      last_aloud_sentence_index: null,
      last_aloud_offset_seconds: 0
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    env.tts.emit({
      state: 'speaking', mode: 'article', articleId: 'a1',
      currentIndex: 0, currentTime: 1, completion: { reachedEnd: false }
    });
    assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);

    env.tts.emit({
      state: 'speaking', mode: 'article', articleId: 'a1',
      currentIndex: 1, currentTime: 0, completion: { reachedEnd: false }
    });
    assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);

    env.tts.emit({
      state: 'paused', mode: 'article', articleId: 'a1',
      currentIndex: 1, currentTime: 2, completion: { reachedEnd: false }
    });
    assert.equal(
      env.root.querySelector('[data-role="aloud-resume-marker"]').nextElementSibling.dataset.sentenceIndex,
      '1'
    );

    env.tts.emit({
      state: 'speaking', mode: 'article', articleId: 'a1',
      currentIndex: 1, currentTime: 2, completion: { reachedEnd: false }
    });
    assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('full-reading start synchronously checkpoints the requested target without making it audible', async () => {
  const env = setupReader({
    articleProgress: { last_position_ratio: 0 },
    publishStart: false
  });
  try {
    await env.ready();
    const current = env.root.querySelector('[data-action="speech-current"]');
    assert.equal(current.disabled, true);

    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));

    assert.deepEqual(env.tts.starts.at(-1), {
      articleId: 'a1', startIndex: 0, offsetSeconds: 0, profile: 'aria-narration'
    });
    assert.deepEqual(env.checkpointStore.lastSaved, {
      sentenceIndex: 0, offsetSeconds: 0, state: 'paused'
    });
    assert.equal(env.tts.controller.getSnapshot().currentIndex, null);
    assert.equal(current.disabled, true);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('pagehide preserves a different pending full-reading target over the old audible checkpoint', async () => {
  const env = setupReader({
    checkpoint: {
      sentenceIndex: 0,
      offsetSeconds: 7,
      state: 'paused'
    },
    liveSnapshot: {
      state: 'paused',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 0,
      currentTime: 7
    },
    publishStart: false
  });
  try {
    await env.ready();
    const sentence = env.root.querySelector('[data-sentence-index="2"]');
    env.window.getSelection = () => validSelection(sentence, {
      text: 'Third sentence.'
    });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    click(
      env.window,
      env.root.querySelector('[data-action="speech-start-selection"]')
    );
    assert.deepEqual(env.tts.starts.at(-1), {
      articleId: 'a1', startIndex: 2, offsetSeconds: 0, profile: 'aria-narration'
    });
    assert.equal(env.tts.controller.getSnapshot().currentIndex, 0);

    env.window.dispatchEvent(new env.window.Event('pagehide'));

    assert.deepEqual(env.checkpointStore.lastSaved, {
      sentenceIndex: 2, offsetSeconds: 0, state: 'paused'
    });
    assert.deepEqual(env.progressQueue.snapshot().at(-1), {
      kind: 'position',
      articleId: 'a1',
      lastPositionRatio: 0,
      lastAloudSentenceIndex: 2,
      lastAloudOffsetSeconds: 0
    });
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('pagehide atomically checkpoints the last actually audible sentence and offset', async () => {
  const env = setupReader({
    articleProgress: { last_position_ratio: 0 }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    env.tts.emit({ state: 'speaking', currentIndex: 2, currentTime: 4.25 });

    env.window.dispatchEvent(new env.window.Event('pagehide'));
    assert.deepEqual(env.checkpointStore.lastSaved, {
      sentenceIndex: 2, offsetSeconds: 4.25, state: 'paused'
    });
    assert.deepEqual(env.progressQueue.snapshot().at(-1), {
      kind: 'position',
      articleId: 'a1',
      lastPositionRatio: 0,
      lastAloudSentenceIndex: 2,
      lastAloudOffsetSeconds: 4.25
    });
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader restart clears local and queued read-aloud positions', async () => {
  const env = setupReader({
    checkpoint: { sentenceIndex: 1, offsetSeconds: 2, state: 'paused' },
    articleProgress: { last_position_ratio: 0 },
    publishStart: false
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="speech-restart"]'));

    assert.equal(env.checkpointStore.clearedArticleId, 'a1');
    assert.deepEqual(env.progressQueue.snapshot().at(-1), {
      kind: 'position',
      articleId: 'a1',
      lastPositionRatio: 0,
      lastAloudSentenceIndex: 0,
      lastAloudOffsetSeconds: 0
    });
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('expired timer pauses and checkpoints on pageshow', async () => {
  const env = setupReader({
    timerDeadline: 100,
    now: 200,
    liveSnapshot: {
      state: 'speaking',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 1,
      currentTime: 2
    }
  });
  try {
    await env.ready();
    env.window.dispatchEvent(new env.window.Event('pageshow'));
    assert.equal(env.tts.pauseCalls, 1);
    assert.match(
      env.root.querySelector('[data-role="speech-status"]').textContent,
      /定时结束/
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader maps Media Session actions and cleanup preserves a future timer', async () => {
  const env = setupReader({
    timerDeadline: 60_000,
    liveSnapshot: {
      state: 'paused',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 1,
      currentTime: 2.5
    }
  });
  try {
    await env.ready();
    env.mediaSession.handlers.get('play')();
    env.mediaSession.handlers.get('pause')();
    env.mediaSession.handlers.get('previoustrack')();
    env.mediaSession.handlers.get('seekbackward')();
    env.mediaSession.handlers.get('nexttrack')();
    assert.deepEqual(
      env.tts.calls.filter(call => ['resume', 'pause', 'previous', 'current', 'next'].includes(call)),
      ['resume', 'pause', 'previous', 'current', 'next']
    );

    env.cleanup();
    assert.equal(env.mediaSession.handlers.size, 0);
    assert.notEqual(env.window.localStorage.getItem(env.timerKey), null);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('natural completion releases Media Session and a new full-reading session rebinds it', async () => {
  const env = setupReader({
    articleProgress: { last_position_ratio: 0 },
    liveSnapshot: {
      state: 'speaking',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 1,
      currentTime: 2
    }
  });
  try {
    await env.ready();
    assert.equal(env.mediaSession.playbackState, 'playing');
    assert.notEqual(env.mediaSession.metadata, null);
    assert.equal(env.mediaSession.handlers.has('play'), true);

    env.tts.emit({
      state: 'idle',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 1,
      completion: { reachedEnd: true, coverage: 1, counted: true },
      completionEvent: { reachedEnd: true, coverage: 1, counted: true }
    });

    assert.equal(env.mediaSession.handlers.size, 0);
    assert.equal(env.mediaSession.metadata, null);
    assert.equal(env.mediaSession.playbackState, 'none');

    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    assert.equal(env.mediaSession.handlers.has('play'), true);
    assert.equal(env.mediaSession.handlers.has('pause'), true);
    assert.equal(env.mediaSession.handlers.has('seekbackward'), true);
    assert.notEqual(env.mediaSession.metadata, null);
    env.mediaSession.handlers.get('seekbackward')();
    assert.equal(env.tts.calls.at(-1), 'current');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('foreign TTS playback disables saved-index replay controls', async () => {
  const env = setupReader({
    articleProgress: { last_position_ratio: 0, last_aloud_sentence_index: 1 },
    liveSnapshot: {
      state: 'speaking', mode: 'article', articleId: 'a2', currentIndex: 1, currentTime: 0
    }
  });
  try {
    await env.ready();
    const controls = [
      'speech-previous', 'speech-current',
      'speech-floating-previous', 'speech-floating-current'
    ].map(action => env.root.querySelector(`[data-action="${action}"]`));

    assert.ok(controls.every(control => control.disabled));
    for (const control of controls) click(env.window, control);
    assert.deepEqual(env.tts.calls, []);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('restored expired timer renders one idle expiry status on mount', async () => {
  const env = setupReader({ timerDeadline: 100, now: 200 });
  try {
    await env.ready();
    const remaining = env.root.querySelector('[data-role="sleep-timer-remaining"]');
    const status = env.root.querySelector('[data-role="speech-status"]');
    assert.equal(remaining.textContent, '定时结束');
    assert.equal(remaining.hidden, false);
    assert.match(status.textContent, /定时结束/);

    env.window.dispatchEvent(new env.window.Event('pageshow'));
    assert.equal(remaining.textContent, '定时结束');
    assert.equal(status.textContent, '定时结束，已暂停');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader exposes direct replay and sleep timer controls for touch use', async () => {
  const env = setupReader();
  try {
    await env.ready();
    const previous = env.root.querySelector('[data-action="speech-previous"]');
    const current = env.root.querySelector('[data-action="speech-current"]');
    const timer = env.root.querySelector('[data-action="speech-timer"]');
    const remaining = env.root.querySelector('[data-role="sleep-timer-remaining"]');
    const topRateOutput = env.root.querySelector('[data-role="speech-rate-value"]');

    assert.equal(previous.disabled, true);
    assert.equal(current.disabled, false);
    for (const action of ['speech-previous', 'speech-floating-previous']) {
      const button = env.root.querySelector(`[data-action="${action}"]`);
      assert.equal(button.textContent.trim(), '上一句');
      assert.equal(button.getAttribute('aria-label'), '重播上一句');
      assert.ok(button.querySelector('svg'));
    }
    for (const action of ['speech-current', 'speech-floating-current']) {
      const button = env.root.querySelector(`[data-action="${action}"]`);
      assert.equal(button.textContent.trim(), '重听');
      assert.equal(button.getAttribute('aria-label'), '重新朗读当前句');
      assert.ok(button.querySelector('svg'));
    }
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="floating-speech"] [data-action]')]
        .map(node => node.dataset.action),
      [
        'speech-floating-previous',
        'speech-floating-current',
        'speech-floating-toggle',
        'speech-floating-timer',
        'speech-rate-cycle'
      ]
    );
    for (const action of [
      'speech-floating-previous',
      'speech-floating-current',
      'speech-floating-toggle',
      'speech-floating-timer'
    ]) {
      const button = env.root.querySelector(`[data-action="${action}"]`);
      assert.ok(button.querySelector('svg'));
      assert.ok(button.querySelector('.pc-floating-speech-label'));
    }
    const floatingRate = env.root.querySelector('[data-action="speech-rate-cycle"]');
    assert.equal(floatingRate.textContent.trim(), '1×');
    assert.equal(floatingRate.getAttribute('aria-label'), '切换朗读语速，当前 1 倍');
    for (const expected of [1.25, 1.5, 0.5, 0.75, 1]) {
      click(env.window, floatingRate);
      assert.equal(env.tts.controller.getRate(), expected);
      assert.equal(env.root.querySelector('[data-action="speech-rate"]').value, String(expected));
      assert.equal(topRateOutput.textContent, `${expected}×`);
      assert.equal(floatingRate.textContent.trim(), `${expected}×`);
      assert.equal(floatingRate.getAttribute('aria-label'), `切换朗读语速，当前 ${expected} 倍`);
    }

    env.tts.emit({
      state: 'speaking', mode: 'article', articleId: 'a1', currentIndex: 1,
      currentTime: 0, completion: { reachedEnd: false, coverage: 0, counted: false }
    });
    assert.equal(previous.disabled, false);
    click(env.window, previous);
    click(env.window, current);
    assert.deepEqual(env.tts.calls.slice(-2), ['previous', 'current']);

    timer.focus();
    click(env.window, timer);
    let panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    assert.ok(panel);
    const custom = panel.querySelector('[data-role="sleep-timer-custom"]');
    assert.deepEqual([custom.type, custom.min, custom.step], ['number', '1', '1']);
    custom.value = '0';
    click(env.window, panel.querySelector('.pc-sleep-timer-custom-label + [data-action="speech-timer-set"]'));
    assert.match(panel.querySelector('[data-role="sleep-timer-error"]').textContent, /正整数/);

    click(env.window, panel.querySelector('[data-action="speech-timer-set"][data-minutes="10"]'));
    assert.equal(env.root.querySelector('[data-role="sleep-timer-panel"]'), null);
    assert.equal(remaining.textContent, '10:00');
    const floatingTimer = env.root.querySelector('[data-action="speech-floating-timer"]');
    assert.equal(floatingTimer.textContent, '10:00');
    assert.match(floatingTimer.getAttribute('aria-label'), /10:00/);
    env.setNow(1_000);
    env.intervals.find(entry => entry.delay === 1_000).callback();
    assert.equal(floatingTimer.textContent, '9:59');
    assert.match(floatingTimer.getAttribute('aria-label'), /9:59/);

    click(env.window, remaining);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    assert.ok(panel, 'clicking the visible countdown should reopen the timer panel');
    click(env.window, panel.querySelector('[data-action="speech-timer-set"][data-minutes="20"]'));
    assert.equal(remaining.textContent, '20:00');

    click(env.window, timer);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    click(env.window, panel.querySelector('[data-action="speech-timer-set"][data-minutes="30"]'));
    assert.equal(remaining.textContent, '30:00');

    click(env.window, timer);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    click(env.window, panel.querySelector('[data-action="speech-timer-set"][data-minutes="60"]'));
    assert.equal(remaining.textContent, '60:00');

    click(env.window, timer);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    panel.querySelector('[data-role="sleep-timer-custom"]').value = '10000';
    click(env.window, panel.querySelector('.pc-sleep-timer-custom-label + [data-action="speech-timer-set"]'));
    assert.equal(remaining.textContent, '10000:00');
    assert.equal(floatingTimer.textContent, '99m+');
    assert.match(floatingTimer.getAttribute('aria-label'), /10000:00/);

    click(env.window, timer);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    panel.querySelector('[data-role="sleep-timer-custom"]').value = '7';
    click(env.window, panel.querySelector('.pc-sleep-timer-custom-label + [data-action="speech-timer-set"]'));
    assert.equal(remaining.textContent, '7:00');
    assert.equal(env.window.document.activeElement, timer);

    click(env.window, timer);
    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.querySelector('[data-role="sleep-timer-panel"]'), null);
    assert.equal(env.window.document.activeElement, timer);

    click(env.window, timer);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    click(env.window, panel.querySelector('[data-action="speech-timer-cancel"]'));
    assert.equal(remaining.hidden, true);
    assert.equal(floatingTimer.textContent, '\u5b9a\u65f6');
    assert.equal(
      floatingTimer.getAttribute('aria-label'),
      '\u8bbe\u7f6e\u505c\u6b62\u6717\u8bfb\u5b9a\u65f6\u5668'
    );
    assert.equal(env.window.document.activeElement, timer);

    click(env.window, timer);
    click(env.window, env.window.document.body);
    assert.equal(env.root.querySelector('[data-role="sleep-timer-panel"]'), null);
    assert.equal(env.window.document.activeElement, timer);

    click(env.window, timer);
    panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    click(env.window, panel.querySelector('[data-action="speech-timer-set"][data-minutes="10"]'));
    env.setNow(601_001);
    for (const interval of env.intervals) interval.callback();
    assert.equal(remaining.textContent, '定时结束');
    assert.match(env.root.querySelector('[data-role="speech-status"]').textContent, /定时结束/);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader identifies each floating primary-action icon across speech states', async () => {
  const env = setupReader({
    articleProgress: {
      last_position_ratio: 0,
      last_aloud_sentence_index: null,
      last_aloud_offset_seconds: 0
    }
  });
  try {
    await env.ready();
    const toggle = env.root.querySelector('[data-action="speech-floating-toggle"]');
    const iconName = () => toggle.querySelector('svg').dataset.icon;

    assert.equal(iconName(), 'target');
    click(env.window, toggle);
    assert.equal(iconName(), 'close');

    env.tts.emit({
      state: 'speaking', mode: 'article', articleId: 'a1', currentIndex: 1,
      currentTime: 0, completion: { reachedEnd: false, coverage: 0, counted: false }
    });
    assert.equal(iconName(), 'pause');

    env.tts.emit({
      state: 'paused', mode: 'article', articleId: 'a1', currentIndex: 1,
      currentTime: 0, completion: { reachedEnd: false, coverage: 0, counted: false }
    });
    assert.equal(iconName(), 'play');
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader settings apply global typography preferences and restore focus on dismissal', async () => {
  const env = setupReader();
  try {
    await env.ready();
    const content = env.root.querySelector('.pc-reader-content');
    const trigger = env.root.querySelector('[data-action="reader-settings"]');
    assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.deepEqual([
      content.style.getPropertyValue('--reader-font-size'),
      content.style.getPropertyValue('--reader-line-height'),
      content.style.getPropertyValue('--reader-max-width')
    ], ['19px', '1.9', '760px']);

    trigger.focus();
    click(env.window, trigger);
    let panel = env.root.querySelector('[data-role="reader-settings-panel"]');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.equal(
      panel.querySelector('[data-preference="fontSize"][data-value="medium"]').getAttribute('aria-pressed'),
      'true'
    );

    click(env.window, panel.querySelector('[data-preference="fontSize"][data-value="large"]'));
    click(env.window, panel.querySelector('[data-preference="lineHeight"][data-value="loose"]'));
    click(env.window, panel.querySelector('[data-preference="measure"][data-value="wide"]'));
    assert.deepEqual([
      content.style.getPropertyValue('--reader-font-size'),
      content.style.getPropertyValue('--reader-line-height'),
      content.style.getPropertyValue('--reader-max-width')
    ], ['21px', '2.1', '880px']);
    assert.deepEqual(JSON.parse(env.window.localStorage.getItem(READER_PREFERENCES_KEY)), {
      fontSize: 'large', lineHeight: 'loose', measure: 'wide'
    });

    click(env.window, env.window.document.body);
    assert.equal(env.root.querySelector('[data-role="reader-settings-panel"]'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(env.window.document.activeElement, trigger);

    click(env.window, trigger);
    panel = env.root.querySelector('[data-role="reader-settings-panel"]');
    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(panel.isConnected, false);
    assert.equal(env.window.document.activeElement, trigger);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader settings persist the article voice and use it for full reading', async () => {
  const env = setupReader();
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="reader-settings"]'));
    const select = env.root.querySelector('[data-action="article-tts-profile"]');
    assert.equal(select.value, 'aria-narration');
    select.value = 'guy-news';
    select.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="reader-settings"]'));
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));

    assert.equal(env.tts.starts.at(-1).profile, 'guy-news');
    assert.match(env.window.localStorage.getItem('pc-tts-preferences'), /"articleProfile":"guy-news"/);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('opening reader settings exits sentence-start selection so one Escape closes the panel', async () => {
  const env = setupReader({ articleProgress: { last_position_ratio: 0 } });
  try {
    await env.ready();
    const selectionToggle = env.root.querySelector('[data-action="speech-floating-toggle"]');
    click(env.window, selectionToggle);
    assert.equal(env.root.classList.contains('pc-reader-start-selecting'), true);

    const settings = env.root.querySelector('[data-action="reader-settings"]');
    click(env.window, settings);
    assert.ok(env.root.querySelector('[data-role="reader-settings-panel"]'));

    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.classList.contains('pc-reader-start-selecting'), false);
    assert.equal(env.root.querySelector('[data-role="reader-settings-panel"]'), null);
    assert.equal(env.window.document.activeElement, settings);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('desktop sleep timer uses its measured size and repositions within the viewport', async () => {
  const env = setupReader();
  const prototype = env.window.HTMLElement.prototype;
  const originalRect = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.matches?.('[data-role="sleep-timer-panel"]')) {
      return { left: 0, top: 0, right: 312, bottom: 366, width: 312, height: 366 };
    }
    return originalRect.call(this);
  };
  try {
    await env.ready();
    Object.defineProperty(env.window, 'innerWidth', { configurable: true, value: 1366 });
    Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 768 });
    const timer = env.root.querySelector('[data-action="speech-timer"]');
    timer.getBoundingClientRect = () => ({ left: 1100, top: 700, bottom: 744 });

    click(env.window, timer);
    const panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    assert.deepEqual([
      panel.style.getPropertyValue('--sleep-timer-left'),
      panel.style.getPropertyValue('--sleep-timer-top')
    ], ['1042px', '326px']);
    assert.ok(panel.querySelector('[data-action="speech-timer-cancel"]'));

    Object.defineProperty(env.window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 600 });
    env.window.dispatchEvent(new env.window.Event('resize'));
    assert.deepEqual([
      panel.style.getPropertyValue('--sleep-timer-left'),
      panel.style.getPropertyValue('--sleep-timer-top')
    ], ['700px', '222px']);
  } finally {
    prototype.getBoundingClientRect = originalRect;
    env.cleanup();
    env.restore();
  }
});

test('sleep timer dialog makes reader controls inert and restores them on close', async () => {
  const env = setupReader();
  try {
    await env.ready();
    const timer = env.root.querySelector('[data-action="speech-timer"]');
    const floatingToggle = env.root.querySelector('[data-action="speech-floating-toggle"]');
    timer.focus();
    click(env.window, timer);
    const panel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    const background = env.root.querySelector('.pc-reader-header');
    const speechControls = [
      ...env.root.querySelectorAll('[data-role="speech-toolbar"] button, [data-role="speech-toolbar"] input, [data-role="floating-speech"] button')
    ];

    assert.equal(panel.getAttribute('aria-modal'), 'true');
    assert.equal(background.hasAttribute('inert'), true);
    assert.ok(speechControls.every(control => control.disabled));
    floatingToggle.focus();
    assert.notEqual(env.window.document.activeElement, floatingToggle);

    click(env.window, panel.querySelector('[data-action="speech-timer-cancel"]'));
    assert.equal(background.hasAttribute('inert'), false);
    assert.equal(env.window.document.activeElement, timer);

    click(env.window, timer);
    const unmountedPanel = env.root.querySelector('[data-role="sleep-timer-panel"]');
    env.cleanup();
    assert.equal(unmountedPanel.isConnected, false);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('sleep timer immediately hides floating controls and keeps them disabled through TTS updates', async () => {
  const env = setupReader({
    articleProgress: { last_position_ratio: 0, last_aloud_sentence_index: 1 }
  });
  try {
    await env.ready();
    const toolbar = env.root.querySelector('[data-role="speech-toolbar"]');
    toolbar.getBoundingClientRect = () => ({ bottom: -1 });
    env.window.dispatchEvent(new env.window.Event('scroll'));
    const floating = env.root.querySelector('[data-role="floating-speech"]');
    const timer = env.root.querySelector('[data-action="speech-timer"]');
    const controls = () => [...env.root.querySelectorAll(
      '[data-role="speech-toolbar"] button, [data-role="speech-toolbar"] input, [data-role="floating-speech"] button'
    )];
    assert.equal(floating.hidden, false);

    click(env.window, timer);
    assert.equal(floating.hidden, true);
    assert.ok(controls().every(control => control.disabled));

    env.tts.emit({
      state: 'speaking', mode: 'article', articleId: 'a1', currentIndex: 1, currentTime: 0,
      completion: { reachedEnd: false, coverage: 0, counted: false }
    });
    assert.equal(floating.hidden, true);
    assert.ok(controls().every(control => control.disabled));

    click(env.window, env.root.querySelector('[data-action="speech-timer-cancel"]'));
    assert.equal(floating.hidden, false);
    assert.equal(env.root.querySelector('[data-action="speech-primary"]').disabled, false);
    assert.equal(env.root.querySelector('[data-action="speech-floating-toggle"]').disabled, false);

    click(env.window, timer);
    env.tts.emit({
      state: 'paused', mode: 'article', articleId: 'a1', currentIndex: 1, currentTime: 0,
      completion: { reachedEnd: false, coverage: 0, counted: false }
    });
    assert.equal(floating.hidden, true);
    assert.ok(controls().every(control => control.disabled));
    click(env.window, env.root.querySelector('[data-action="speech-timer-cancel"]'));
    assert.equal(floating.hidden, false);
    assert.equal(env.root.querySelector('[data-action="speech-primary"]').disabled, false);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader warns when the player falls back to lock-screen-limited speech', async () => {
  const env = setupReader({
    liveSnapshot: {
      state: 'paused',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 0,
      currentTime: 1,
      fallbackActive: true
    }
  });
  try {
    await env.ready();
    assert.match(
      env.root.querySelector('[data-role="speech-fallback-warning"]').textContent,
      /锁屏后台播放可能受限/
    );
    assert.equal(
      env.speech.calls.some(call => call[0] === 'load'),
      false,
      'rendering a live TTS fallback must not cancel and reload browser speech'
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('reader ignores another article TTS snapshot across UI metadata and timer expiry', async () => {
  const env = setupReader({
    timerDeadline: 100,
    now: 0,
    articleProgress: {
      last_position_ratio: 0,
      last_aloud_sentence_index: 1,
      last_aloud_offset_seconds: 0.75
    },
    liveSnapshot: {
      state: 'speaking',
      mode: 'article',
      articleId: 'a2',
      currentIndex: 2,
      currentTime: 4
    }
  });
  try {
    await env.ready();
    assert.equal(
      env.root.querySelector('[data-action="speech-primary"]').textContent,
      '继续'
    );
    assert.equal(env.root.querySelector('.pc-sentence-speaking'), null);
    assert.equal(env.mediaSession.metadata, null);

    env.setNow(200);
    env.window.dispatchEvent(new env.window.Event('pageshow'));
    assert.equal(env.tts.pauseCalls, 0);

    for (const action of ['play', 'pause', 'previoustrack', 'seekbackward', 'nexttrack']) {
      env.mediaSession.handlers.get(action)?.();
    }
    assert.deepEqual(
      env.tts.calls.filter(call =>
        ['resume', 'pause', 'previous', 'current', 'next'].includes(call)
      ),
      []
    );
    env.cleanup();
    assert.equal(
      env.tts.calls.includes('stop'),
      false,
      'unmounting this article must not stop another article playback'
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('timer expiry immediately stops an active direct pronunciation while TTS exists', async () => {
  const env = setupReader({
    timerDeadline: 100,
    now: 0,
    body: 'Deploy safely. Second sentence. Third sentence.'
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('.pc-term'));
    click(env.window, env.root.querySelector('[data-action="pronounce"]'));
    assert.deepEqual(env.speech.calls.at(-1), ['speakOnce', 'Deploy']);

    env.setNow(200);
    env.intervals.find(item => item.delay === 1_000).callback();

    assert.deepEqual(env.speech.calls.at(-1), ['stop']);
    assert.match(
      env.root.querySelector('[data-role="speech-status"]').textContent,
      /定时结束/
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('expired timer blocks every direct sentence and Media Session playback entry', async () => {
  const directEntries = [
    {
      name: 'ordinary click',
      prepare() {},
      perform(env) {
        click(env.window, env.root.querySelector('[data-sentence-index="0"]'));
      },
      attempted(env) {
        return env.tts.calls.some(call => Array.isArray(call) && call[0] === 'point');
      }
    },
    {
      name: 'ordinary keyboard',
      prepare() {},
      perform(env) {
        env.root.querySelector('[data-sentence-index="0"]').dispatchEvent(
          new env.window.KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true
          })
        );
      },
      attempted(env) {
        return env.tts.calls.some(call => Array.isArray(call) && call[0] === 'point');
      }
    },
    {
      name: 'selected start click',
      prepare(env) {
        click(env.window, env.root.querySelector('[data-role="floating-speech-toggle"]'));
      },
      perform(env) {
        click(env.window, env.root.querySelector('[data-sentence-index="1"]'));
      },
      attempted(env) { return env.tts.starts.length > 0; }
    },
    {
      name: 'selected start keyboard',
      prepare(env) {
        click(env.window, env.root.querySelector('[data-role="floating-speech-toggle"]'));
      },
      perform(env) {
        env.root.querySelector('[data-sentence-index="1"]').dispatchEvent(
          new env.window.KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true
          })
        );
      },
      attempted(env) { return env.tts.starts.length > 0; }
    },
    {
      name: 'term pronunciation',
      options: { body: 'Deploy safely. Second sentence. Third sentence.' },
      prepare(env) {
        click(env.window, env.root.querySelector('.pc-term'));
      },
      perform(env) {
        click(env.window, env.root.querySelector('[data-action="pronounce"]'));
      },
      attempted(env) {
        return env.speech.calls.some(call => call[0] === 'speakOnce');
      }
    },
    {
      name: 'selection pronunciation',
      prepare(env) {
        const sentence = env.root.querySelector('[data-sentence-index="0"]');
        env.window.getSelection = () => validSelection(sentence, { text: 'First' });
        sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
      },
      perform(env) {
        click(env.window, env.root.querySelector('[data-action="pronounce-selection"]'));
      },
      attempted(env) {
        return env.speech.calls.some(call => call[0] === 'speakOnce');
      }
    },
    {
      name: 'floating current replay',
      options: {
        articleProgress: { last_position_ratio: 0, last_aloud_sentence_index: 0 }
      },
      prepare() {},
      perform(env) {
        click(env.window, env.root.querySelector('[data-action="speech-floating-current"]'));
      },
      attempted(env) {
        return env.tts.calls.includes('current');
      }
    },
    {
      name: 'toolbar rate input',
      prepare() {},
      perform(env) {
        const rate = env.root.querySelector('[data-action="speech-rate"]');
        rate.value = '1.5';
        rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      },
      attempted(env) {
        return env.tts.calls.some(call => Array.isArray(call) && call[0] === 'rate');
      }
    }
  ];
  for (const entry of directEntries) {
    const env = setupReader({
      timerDeadline: 100,
      now: 0,
      articleProgress: { last_position_ratio: 0 },
      ...entry.options
    });
    try {
      await env.ready();
      entry.prepare(env);
      env.setNow(200);
      entry.perform(env);
      assert.equal(entry.attempted(env), false, entry.name);
      assert.match(
        env.root.querySelector('[data-role="speech-status"]').textContent,
        /定时结束/,
        entry.name
      );
    } finally {
      env.cleanup();
      env.restore();
    }
  }

  for (const [action, attemptedCall] of [
    ['previoustrack', 'previous'],
    ['seekbackward', 'current'],
    ['nexttrack', 'next']
  ]) {
    const env = setupReader({
      timerDeadline: 100,
      now: 0,
      liveSnapshot: {
        state: 'paused',
        mode: 'article',
        articleId: 'a1',
        currentIndex: 1,
        currentTime: 1
      }
    });
    try {
      await env.ready();
      env.setNow(200);
      env.mediaSession.handlers.get(action)();
      assert.equal(env.tts.calls.includes(attemptedCall), false, action);
      assert.equal(env.tts.pauseCalls, 1, action);
    } finally {
      env.cleanup();
      env.restore();
    }
  }
});

test('one-off sentence playback publishes its own metadata and coherent Media Session actions', async () => {
  const env = setupReader({
    liveSnapshot: {
      state: 'paused',
      mode: 'article',
      articleId: 'a1',
      currentIndex: 2,
      currentTime: 1
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-sentence-index="0"]'));

    assert.equal(env.mediaSession.metadata.album, 'First sentence.');
    assert.equal(env.mediaSession.playbackState, 'playing');
    assert.equal(env.mediaSession.handlers.has('previoustrack'), false);
    assert.equal(env.mediaSession.handlers.has('nexttrack'), false);
    env.mediaSession.handlers.get('seekbackward')();
    assert.deepEqual(
      env.tts.calls.filter(call => Array.isArray(call) && call[0] === 'point').at(-1),
      ['point', 'a1', 0, 'First sentence.', 'aria-narration']
    );
  } finally {
    env.cleanup();
    env.restore();
  }
});

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

test('long reading exposes offscreen floating controls and a cross-device resume marker', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const submissions = [];
  let observerCallback = null;
  let observedToolbar = null;
  let disconnects = 0;
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail({
      progress: { last_position_ratio: 0, last_aloud_sentence_index: 1 }
    }),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressQueue: {
      submit: async item => { submissions.push(item); return true; },
      retry: async () => true
    },
    progressRuntime: {
      setInterval: () => 1,
      clearInterval() {},
      requestAnimationFrame: callback => callback(),
      createIntersectionObserver(callback) {
        observerCallback = callback;
        return {
          observe(node) { observedToolbar = node; },
          disconnect() { disconnects += 1; }
        };
      }
    }
  });
  try {
    await flush();
    assert.equal(observedToolbar.dataset.role, 'speech-toolbar');
    const entry = env.root.querySelector('[data-role="aloud-resume-entry"]');
    assert.equal(entry.querySelector('[data-action="speech-continue-resume"]'), null);
    assert.equal(entry.querySelector('[data-action="speech-jump-resume"]').textContent, '\u8df3\u8f6c');
    assert.match(env.root.querySelector('[data-role="aloud-resume-entry"]').textContent, /第 2 句/);
    assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]').nextElementSibling.dataset.sentenceIndex, '1');

    const resumedSentence = env.root.querySelector('[data-sentence-index="1"]');
    let located = null;
    resumedSentence.scrollIntoView = options => { located = options; };
    click(env.window, env.root.querySelector('[data-action="speech-jump-resume"]'));
    assert.equal(located.block, 'center');
    assert.equal(env.window.document.activeElement, resumedSentence);
    assert.equal(speech.calls.some(call => call[0] === 'startAt'), false);

    observerCallback([{ isIntersecting: false }]);
    const savedFloatingToggle = env.root.querySelector('[data-role="floating-speech-toggle"]');
    assert.equal(savedFloatingToggle.textContent, '继续');

    speech.emit({ state: 'once', currentIndex: null, completion: { reachedEnd: false } });
    assert.equal(savedFloatingToggle.textContent, '选择起点');
    const callsBeforeSelection = speech.calls.length;
    click(env.window, savedFloatingToggle);
    assert.equal(speech.calls.length, callsBeforeSelection);
    assert.equal(env.root.querySelector('[data-role="reader-start-hint"]').hidden, false);
    click(env.window, savedFloatingToggle);
    assert.equal(env.root.querySelector('[data-role="reader-start-hint"]').hidden, true);
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: false } });
    assert.equal(savedFloatingToggle.textContent, '继续');

    click(env.window, savedFloatingToggle);
    assert.deepEqual(speech.calls.at(-1), ['startAt', 1]);

    const primary = env.root.querySelector('[data-action="speech-primary"]');
    assert.equal(primary.textContent, '继续');
    assert.equal(env.root.querySelector('[data-action="speech-restart"]').hidden, false);
    click(env.window, primary);
    assert.deepEqual(speech.calls.at(-1), ['startAt', 1]);

    speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
    observerCallback([{ isIntersecting: false }]);
    const floating = env.root.querySelector('[data-role="floating-speech"]');
    assert.equal(floating.hidden, false);
    click(env.window, env.root.querySelector('[data-action="speech-floating-current"]'));
    assert.deepEqual(speech.calls.at(-1), [
      'speakOnce',
      env.root.querySelector('[data-sentence-index="1"]').textContent
    ]);

    speech.emit({ state: 'paused', currentIndex: 1, completion: { reachedEnd: false } });
    assert.equal(env.root.querySelector('[data-role="floating-speech-toggle"]').textContent, '继续');
    assert.equal(submissions.at(-1).lastAloudSentenceIndex, 1);

    click(env.window, env.root.querySelector('.pc-term'));
    assert.equal(floating.hidden, true);
    click(env.window, env.root.querySelector('[data-action="close-popover"]'));
    assert.equal(floating.hidden, false);

    click(env.window, primary);
    assert.deepEqual(speech.calls.at(-1), ['resume']);

    speech.emit({
      state: 'idle', currentIndex: null,
      completion: { reachedEnd: true }, completionEvent: { counted: true }
    });
    assert.equal(floating.hidden, false);
    assert.equal(env.root.querySelector('[data-role="floating-speech-toggle"]').textContent, '选择起点');
    assert.equal(env.root.querySelector('[data-role="aloud-resume-entry"]').hidden, true);
    assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);
    assert.equal(submissions.filter(item => item.kind === 'position').at(-1).lastAloudSentenceIndex, null);
  } finally {
    cleanup();
    assert.equal(disconnects, 1);
    env.restore();
  }
});

test('keeps the active full-reading sentence within the viewport safe zone', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const scrollCalls = [];
  Object.defineProperty(env.window, 'innerHeight', {
    configurable: true, value: 800
  });
  env.window.scrollTo = options => { scrollCalls.push(options); };
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail(),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressRuntime: { requestAnimationFrame: callback => callback() }
  });
  try {
    await flush();
    scrollCalls.length = 0;

    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    sentence.getBoundingClientRect = () => ({
      top: 200, bottom: 300, height: 100
    });
    speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
    assert.equal(scrollCalls.length, 0);

    const below = env.root.querySelector('[data-sentence-index="2"]');
    below.getBoundingClientRect = () => ({
      top: 690, bottom: 760, height: 70
    });
    speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false } });
    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].behavior, 'smooth');
    assert.equal(scrollCalls[0].top, 434);

    speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false } });
    assert.equal(scrollCalls.length, 1);

    speech.emit({ state: 'paused', currentIndex: 2, completion: { reachedEnd: false } });
    assert.equal(scrollCalls.length, 1);
  } finally {
    cleanup();
    env.restore();
  }
});

test('does not follow a stale full-reading animation-frame callback', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const frames = [];
  const scrollCalls = [];
  Object.defineProperty(env.window, 'innerHeight', {
    configurable: true, value: 800
  });
  env.window.scrollTo = options => { scrollCalls.push(options); };
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail(),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressRuntime: {
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; }
    }
  });
  try {
    await flush();
    frames.length = 0;

    const first = env.root.querySelector('[data-sentence-index="1"]');
    const current = env.root.querySelector('[data-sentence-index="2"]');
    first.getBoundingClientRect = () => ({
      top: 690, bottom: 760, height: 70
    });
    current.getBoundingClientRect = () => ({
      top: 690, bottom: 760, height: 70
    });

    speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
    speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false } });
    assert.equal(frames.length, 2);

    frames[0]();
    assert.equal(scrollCalls.length, 0);

    frames[1]();
    assert.equal(scrollCalls.length, 1);
  } finally {
    cleanup();
    env.restore();
  }
});

test('uses instant auto-follow scrolling when reduced motion is preferred', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const scrollCalls = [];
  Object.defineProperty(env.window, 'innerHeight', {
    configurable: true, value: 800
  });
  env.window.scrollTo = options => { scrollCalls.push(options); };
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail(),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressRuntime: {
      requestAnimationFrame: callback => callback(),
      prefersReducedMotion: () => true
    }
  });
  try {
    await flush();
    scrollCalls.length = 0;

    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    sentence.getBoundingClientRect = () => ({
      top: 20, bottom: 90, height: 70
    });
    speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
    assert.equal(scrollCalls.at(-1).behavior, 'auto');
  } finally {
    cleanup();
    env.restore();
  }
});

test('long reading start sentence selection uses an idle floating capsule and preserves ordinary sentence actions', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  let observerCallback = null;
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail({
      progress: { last_position_ratio: 0, last_aloud_sentence_index: null }
    }),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressRuntime: {
      setInterval: () => 1,
      clearInterval() {},
      requestAnimationFrame: callback => callback(),
      createIntersectionObserver(callback) {
        observerCallback = callback;
        return { observe() {}, disconnect() {} };
      }
    }
  });
  try {
    await flush();
    observerCallback([{ isIntersecting: false }]);
    const floating = env.root.querySelector('[data-role="floating-speech"]');
    const toggle = floating.querySelector('[data-role="floating-speech-toggle"]');
    assert.equal(floating.hidden, false);
    assert.equal(toggle.textContent, '选择起点');
    assert.equal(toggle.getAttribute('aria-label'), '选择全文朗读起点');

    click(env.window, toggle);
    assert.ok(env.root.classList.contains('pc-reader-start-selecting'));
    assert.equal(toggle.textContent, '取消选择');
    assert.equal(env.root.querySelector('[data-role="reader-start-hint"]').hidden, false);
    assert.equal(speech.calls.some(call => call[0] === 'startAt'), false);

    const chosen = env.root.querySelector('[data-sentence-index="2"]');
    click(env.window, chosen);
    assert.deepEqual(speech.calls.at(-1), ['startAt', 2]);
    assert.equal(env.root.classList.contains('pc-reader-start-selecting'), false);

    click(env.window, toggle);
    const term = env.root.querySelector('[data-sentence-index="2"] .pc-term');
    click(env.window, term);
    assert.deepEqual(speech.calls.at(-1), ['startAt', 2]);
    assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);

    click(env.window, toggle);
    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true
    }));
    assert.equal(env.root.classList.contains('pc-reader-start-selecting'), false);

    click(env.window, env.root.querySelector('[data-sentence-index="0"]'));
    assert.equal(speech.calls.at(-1)[0], 'speakOnce');
  } finally {
    cleanup();
    env.restore();
  }
});

test('long reading preserves the complete saved sentence for CSS truncation', async () => {
  const env = installDom();
  const savedSentence = 'This saved sentence is deliberately longer than thirty-two characters so CSS handles truncation.';
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail({
      body: `First sentence. ${savedSentence} Last sentence.`,
      progress: { last_position_ratio: 0, last_aloud_sentence_index: 1 }
    }),
    articleId: 'a1',
    navigate() {},
    speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    const entry = env.root.querySelector('[data-role="aloud-resume-entry"]');
    assert.ok(entry.textContent.includes(savedSentence));
  } finally {
    cleanup();
    env.restore();
  }
});

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

test('selectionchange opens the selection panel after a 150ms debounce', async () => {
  const env = installDom();
  const timeouts = controlledTimeouts();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {},
    speech: createReaderSpeechFake().controller, progressRuntime: timeouts.runtime
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    env.window.getSelection = () => validSelection(sentence, { text: 'Select this phrase' });

    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));

    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
    assert.equal(timeouts.tasks.size, 1);
    assert.equal([...timeouts.tasks.values()][0].delay, 150);
    timeouts.runLatest();
    assert.equal(
      env.root.querySelector('[data-role="selection-action"]').dataset.selectedText,
      'Select this phrase'
    );
  } finally {
    cleanup();
    env.restore();
  }
});

test('selectionchange coalesces handle updates and keeps only a valid final selection', async () => {
  const env = installDom();
  const timeouts = controlledTimeouts();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {},
    speech: createReaderSpeechFake().controller, progressRuntime: timeouts.runtime
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    let selection = validSelection(sentence, { text: 'Select' });
    env.window.getSelection = () => selection;

    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
    selection = validSelection(sentence, { text: 'Select this phrase' });
    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));

    assert.equal(timeouts.tasks.size, 1);
    assert.equal(timeouts.cleared.length, 1);
    timeouts.runLatest();
    assert.equal(
      env.root.querySelector('[data-role="selection-action"]').dataset.selectedText,
      'Select this phrase'
    );

    selection = { isCollapsed: true, rangeCount: 0, toString: () => '' };
    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
    timeouts.runLatest();
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);

    const firstSentence = env.root.querySelector('[data-sentence-index="0"]');
    selection = {
      anchorNode: firstSentence.firstChild, focusNode: sentence.firstChild,
      isCollapsed: false, rangeCount: 1, toString: () => 'safely. Select',
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) })
    };
    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
    timeouts.runLatest();
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);

    const outside = env.window.document.body.appendChild(env.window.document.createTextNode('Outside text'));
    selection = {
      anchorNode: outside, focusNode: outside, isCollapsed: false, rangeCount: 1,
      toString: () => 'Outside text',
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) })
    };
    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
    timeouts.runLatest();
    assert.equal(env.root.querySelector('[data-role="selection-action"]'), null);
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

test('translation scheduler retries before offering a focused manual continuation', async () => {
  let attempts = 0;
  const detail = articleDetail({ body: 'First paragraph.', markings: [], pending_terms: [], words: [] });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation([], null, { totalBatches: 1 });
      }
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        attempts += 1;
        if (attempts <= 2) {
          const error = new Error(`temporary failure ${attempts}`);
          error.code = 'TRANSLATION_TIMEOUT';
          throw error;
        }
        return progressiveArticleTranslation([0], 0, {
          totalBatches: 1,
          titleZh: '重试标题',
          translations: { 0: '重试译文。' }
        });
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    const full = env.root.querySelector('[data-action="translation-mode"][data-mode="full"]');
    full.focus();
    click(env.window, full);
    const trigger = env.root.querySelector('[data-action="translation-menu"]');

    await waitFor(
      () => env.root.querySelector('[data-action="continue-article-translation"]'),
      'exhausted retry should expose manual continuation'
    );
    assert.equal(attempts, 2);
    assert.equal(env.window.document.activeElement, trigger);
    assert.match(
      env.root.querySelector(':scope > [data-inline-error]').textContent,
      /temporary failure 2/
    );

    const continuation = env.root.querySelector('[data-action="continue-article-translation"]');
    continuation.focus();
    click(env.window, continuation);
    assert.equal(env.window.document.activeElement, trigger);
    await waitFor(
      () => env.root.querySelector('[data-role="paragraph-translation"]')?.textContent === '重试译文。',
      'manual continuation should restart the missing batch'
    );
    assert.equal(attempts, 3);
    assert.equal(env.root.querySelector(':scope > [data-inline-error]'), null);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('refreshes a legacy-compatible fresh translation through every additive plan batch', async () => {
  const calls = [];
  const detail = articleDetail({
    body: 'First paragraph.\n\nSecond paragraph.',
    markings: [], pending_terms: [], words: []
  });
  const cached = progressiveArticleTranslation([0, 1], null, {
    totalBatches: 2,
    titleZh: '旧标题',
    translations: { 0: '旧译文一。', 1: '旧译文二。' }
  });
  cached.model = 'legacy-model';
  cached.updatedAt = 1;
  const env = setupReader({
    body: detail.body,
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return cached;
      const match = path.match(/^\/api\/articles\/a1\/translation\/batches\/(\d+)$/);
      if (match && init.method === 'PUT') {
        const gate = deferred();
        calls.push({ index: Number(match[1]), body: JSON.parse(init.body), gate });
        return gate.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    let trigger = env.root.querySelector('[data-action="translation-menu"]');
    click(env.window, trigger);
    let refresh = env.root.querySelector('[data-action="translate-article"]');
    refresh.focus();
    click(env.window, refresh);
    assert.deepEqual(calls.map(call => call.index), [0]);
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="paragraph-translation"]')].map(node => node.textContent),
      ['旧译文一。', '旧译文二。']
    );
    trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.equal(env.window.document.activeElement, trigger);

    click(env.window, trigger);
    refresh = env.root.querySelector('[data-action="translate-article"]');
    refresh.focus();
    click(env.window, refresh);
    assert.deepEqual(calls.map(call => call.index), [0]);
    assert.ok(calls.every(call => call.body.refresh === true));
    trigger = env.root.querySelector('[data-action="translation-menu"]');
    assert.equal(env.window.document.activeElement, trigger);

    calls[0].gate.resolve(progressiveArticleTranslation([0], 0, {
      totalBatches: 2,
      titleZh: '过期标题',
      translations: { 0: '过期译文。' }
    }));
    await waitFor(() => calls.length === 2, 'replacement should wait for superseded request settlement');
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="paragraph-translation"]')].map(node => node.textContent),
      ['旧译文一。', '旧译文二。']
    );

    calls[1].gate.resolve(progressiveArticleTranslation([0], 0, {
      totalBatches: 2,
      titleZh: '新标题',
      translations: { 0: '新译文一。' }
    }));
    await waitFor(() => calls.length === 3, 'new generation should continue with batch one');
    assert.deepEqual(calls.map(call => call.index), [0, 0, 1]);
    assert.ok(calls.every(call => call.body.refresh === true));
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="paragraph-translation"]')].map(node => node.textContent),
      ['新译文一。', '旧译文二。']
    );
    assert.equal(
      env.root.querySelector('[data-role="article-translation-progress"]')?.textContent,
      '已翻译 1/2 批'
    );

    calls[2].gate.resolve(progressiveArticleTranslation([0, 1], 1, {
      totalBatches: 2,
      titleZh: '新标题',
      translations: { 0: '新译文一。', 1: '新译文二。' }
    }));
    await waitFor(
      () => env.root.querySelectorAll('[data-role="paragraph-translation"]')[1]?.textContent === '新译文二。',
      'second replacement should render'
    );
  } finally {
    env.cleanup();
    for (const call of calls) call.gate.resolve(cached);
    env.restore();
  }
});

test('refresh Continue retries an initial failed replacement with refresh intent', async () => {
  const calls = [];
  const detail = articleDetail({ body: 'First paragraph.', markings: [], pending_terms: [], words: [] });
  const cached = progressiveArticleTranslation([0], null, {
    totalBatches: 1,
    titleZh: '旧标题',
    translations: { 0: '旧译文。' }
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return cached;
      if (path === '/api/articles/a1/translation/batches/0' && init.method === 'PUT') {
        calls.push(JSON.parse(init.body));
        if (calls.length <= 2) {
          const error = new Error(`refresh timeout ${calls.length}`);
          error.code = 'TRANSLATION_TIMEOUT';
          throw error;
        }
        return progressiveArticleTranslation([0], 0, {
          totalBatches: 1,
          titleZh: '新标题',
          translations: { 0: '新译文。' }
        });
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('[data-action="translate-article"]'));

    await waitFor(
      () => env.root.querySelector('[data-action="continue-article-translation"]'),
      'failed refresh should expose Continue after two attempts'
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every(body => body.refresh === true));
    assert.equal(env.root.querySelector('[data-role="paragraph-translation"]').textContent, '旧译文。');

    click(env.window, env.root.querySelector('[data-action="continue-article-translation"]'));
    await waitFor(
      () => env.root.querySelector('[data-role="paragraph-translation"]')?.textContent === '新译文。',
      'Continue should retry the failed refresh batch'
    );

    assert.equal(calls.length, 3);
    assert.ok(calls.every(body => body.refresh === true));
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('refresh Continue requests only replacement batches not completed in its generation', async () => {
  const calls = [];
  const detail = articleDetail({
    body: 'First paragraph.\n\nSecond paragraph.',
    markings: [], pending_terms: [], words: []
  });
  const cached = progressiveArticleTranslation([0, 1], null, {
    totalBatches: 2,
    titleZh: '旧标题',
    translations: { 0: '旧译文一。', 1: '旧译文二。' }
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return cached;
      const match = path.match(/^\/api\/articles\/a1\/translation\/batches\/(\d+)$/);
      if (match && init.method === 'PUT') {
        const index = Number(match[1]);
        calls.push({ index, body: JSON.parse(init.body) });
        if (index === 0) {
          return progressiveArticleTranslation([0], 0, {
            totalBatches: 2,
            titleZh: '新标题',
            translations: { 0: '新译文一。' }
          });
        }
        const batchOneAttempts = calls.filter(call => call.index === 1).length;
        if (batchOneAttempts <= 2) {
          const error = new Error(`batch one timeout ${batchOneAttempts}`);
          error.code = 'TRANSLATION_TIMEOUT';
          throw error;
        }
        return progressiveArticleTranslation([0, 1], 1, {
          totalBatches: 2,
          titleZh: '新标题',
          translations: { 0: '新译文一。', 1: '新译文二。' }
        });
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('[data-action="translate-article"]'));

    await waitFor(
      () => env.root.querySelector('[data-action="continue-article-translation"]'),
      'later refresh failure should expose Continue'
    );
    assert.deepEqual(calls.map(call => call.index), [0, 1, 1]);
    assert.ok(calls.every(call => call.body.refresh === true));
    assert.deepEqual(
      [...env.root.querySelectorAll('[data-role="paragraph-translation"]')].map(node => node.textContent),
      ['新译文一。', '旧译文二。']
    );

    click(env.window, env.root.querySelector('[data-action="continue-article-translation"]'));
    await waitFor(
      () => env.root.querySelectorAll('[data-role="paragraph-translation"]')[1]?.textContent === '新译文二。',
      'Continue should request the remaining replacement batch'
    );

    assert.deepEqual(calls.map(call => call.index), [0, 1, 1, 1]);
    assert.ok(calls.every(call => call.body.refresh === true));
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('forced refresh resumes only unreplaced batches after leaving full mode', async () => {
  const calls = [];
  const detail = articleDetail({
    body: 'First paragraph.\n\nSecond paragraph.',
    markings: [], pending_terms: [], words: []
  });
  const cached = progressiveArticleTranslation([0, 1], null, {
    totalBatches: 2,
    titleZh: '旧标题',
    translations: { 0: '旧译文一。', 1: '旧译文二。' }
  });
  const env = setupReader({
    body: detail.body,
    translationMode: 'full',
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) return cached;
      const match = path.match(/^\/api\/articles\/a1\/translation\/batches\/(\d+)$/);
      if (match && init.method === 'PUT') {
        const gate = deferred();
        calls.push({ index: Number(match[1]), body: JSON.parse(init.body), gate });
        return gate.promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector('[data-action="translate-article"]'));
    assert.deepEqual(calls.map(call => call.index), [0]);

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="original"]'
    ));
    calls[0].gate.resolve(progressiveArticleTranslation([0], 0, {
      totalBatches: 2,
      titleZh: '新标题',
      translations: { 0: '新译文一。' }
    }));
    await env.ready();
    assert.deepEqual(calls.map(call => call.index), [0]);

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    await waitFor(() => calls.length === 2, 'returning to full mode should resume refresh');

    assert.deepEqual(calls.map(call => call.index), [0, 1]);
    assert.ok(calls.every(call => call.body.refresh === true));
  } finally {
    env.cleanup();
    for (const call of calls) call.gate.resolve(cached);
    env.restore();
  }
});

test('translation quota remains terminal when a sibling request rejects later', async () => {
  const quotaRequest = deferred();
  const siblingRequest = deferred();
  const calls = [];
  const detail = articleDetail({
    body: 'Paragraph zero.\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.',
    markings: [], pending_terms: [], words: []
  });
  const env = setupReader({
    body: detail.body,
    apiImpl: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return detail;
      if (path === '/api/articles/a1/translation' && !init.method) {
        return progressiveArticleTranslation();
      }
      const match = path.match(/^\/api\/articles\/a1\/translation\/batches\/(\d+)$/);
      if (match && init.method === 'PUT') {
        const index = Number(match[1]);
        calls.push(index);
        if (index === 0) return progressiveArticleTranslation([0], 0);
        if (index === 1) return quotaRequest.promise;
        if (index === 2) return siblingRequest.promise;
        return deferred().promise;
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    }
  });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    await waitFor(() => calls.length === 3, 'first and sibling batches should start');
    assert.deepEqual(calls, [0, 1, 2]);

    const quotaError = new Error('daily limit reached');
    quotaError.code = 'TRANSLATION_DAILY_LIMIT';
    quotaRequest.reject(quotaError);
    await waitFor(
      () => env.root.querySelector(':scope > [data-inline-error]')?.textContent.includes('今日翻译额度已用完'),
      'quota error should become visible'
    );
    assert.equal(env.root.querySelector('[data-action="continue-article-translation"]'), null);

    const siblingError = new Error('late sibling timeout');
    siblingError.code = 'TRANSLATION_TIMEOUT';
    siblingRequest.reject(siblingError);
    await env.ready();

    assert.match(env.root.querySelector(':scope > [data-inline-error]').textContent, /今日翻译额度已用完/);
    assert.equal(env.root.querySelector('[data-action="continue-article-translation"]'), null);

    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="original"]'
    ));
    click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
    click(env.window, env.root.querySelector(
      '[data-action="translation-mode"][data-mode="full"]'
    ));
    await env.ready();

    assert.deepEqual(calls, [0, 1, 2]);
    assert.equal(env.root.querySelector('[data-action="continue-article-translation"]'), null);
  } finally {
    env.cleanup();
    quotaRequest.resolve(progressiveArticleTranslation([0, 1], 1));
    siblingRequest.resolve(progressiveArticleTranslation([0, 2], 2));
    env.restore();
  }
});

test('browser speech omits a speaker label at the start of a sentence', async () => {
  const env = setupReader({ body: 'Alice: Hello there.', useTts: false });
  try {
    await env.ready();
    click(env.window, env.root.querySelector('[data-sentence-index="0"]'));
    assert.deepEqual(env.speech.calls.filter(call => call[0] === 'speakOnce'), [
      ['speakOnce', 'Hello there.']
    ]);
  } finally {
    env.cleanup();
    env.restore();
  }
});

test('ordinary sentences are keyboard reachable and Enter or Space reads them', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {}, speech: speech.controller
  });
  try {
    await flush();
    const sentence = env.root.querySelector('[data-sentence-index="1"]');
    assert.equal(sentence.tabIndex, 0);
    assert.equal(sentence.getAttribute('role'), 'button');
    sentence.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    sentence.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    assert.deepEqual(speech.calls.filter(call => call[0] === 'speakOnce'), [
      ['speakOnce', sentence.textContent], ['speakOnce', sentence.textContent]
    ]);
  } finally {
    cleanup();
    env.restore();
  }
});

test('invalid cross-sentence selection explains why in a transient toast', async () => {
  const env = installDom();
  const cleanup = createReaderView({
    root: env.root, api: async () => articleDetail(), articleId: 'a1', navigate() {},
    speech: createReaderSpeechFake().controller
  });
  try {
    await flush();
    const first = env.root.querySelector('[data-sentence-index="0"]');
    const second = env.root.querySelector('[data-sentence-index="1"]');
    env.window.getSelection = () => ({
      anchorNode: first.firstChild, focusNode: second.firstChild, isCollapsed: false,
      toString: () => 'safely. Select', rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({}) })
    });
    second.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    assert.match(env.root.querySelector('[data-role="toast"]').textContent, /同一句/);
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
    let panel = env.root.querySelector('[data-role="selection-action"]');
    assertSharedReaderPopover(panel, 'Select this phrase');
    assert.equal(panel.dataset.termState, 'unmarked');
    assert.match(panel.querySelector('[data-role="reader-popover-status"]').textContent, /未标记/);
    assert.ok(panel.querySelector('.pc-reader-popover-status-unmarked'));
    click(env.window, env.root.querySelector('[data-action="close-selection"]'));

    click(env.window, env.root.querySelector('.pc-term-pending'));
    panel = env.root.querySelector('[data-role="term-popover"]');
    assertSharedReaderPopover(panel, 'Again');
    assert.equal(panel.dataset.termState, 'marked');
    assert.ok(panel.querySelector('[data-role="reader-popover-ribbon"]'));
    assert.match(panel.querySelector('[data-role="reader-popover-status"]').textContent, /已标记 · 待整理/);
    assert.match(panel.querySelector('[data-role="reader-popover-status"]').textContent, /尚未加入记词本/);
    assert.ok(panel.querySelector('.pc-reader-popover-status-marked'));
    click(env.window, panel.querySelector('[data-action="close-popover"]'));

    click(env.window, env.root.querySelector('.pc-term-word'));
    panel = env.root.querySelector('[data-role="term-popover"]');
    assertSharedReaderPopover(panel, 'Deployed');
    assert.equal(panel.dataset.termState, 'saved');
    assert.ok(panel.querySelector('[data-role="reader-popover-ribbon"]'));
    assert.match(panel.querySelector('[data-role="reader-popover-status"]').textContent, /已加入记词本/);
    assert.match(panel.querySelector('[data-role="reader-popover-status"]').textContent, /可在词库中复习/);
    assert.ok(panel.querySelector('.pc-reader-popover-status-saved'));
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
    env.window.getSelection = () => validSelection(sentence, {
      text: 'Select this phrase', rect: { left: 140, top: 240, bottom: 260 }
    });
    sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
    click(env.window, env.root.querySelector('[data-action="mark-selection"]'));
    await flush();

    const marked = env.root.querySelector('[data-role="term-popover"]');
    assertSharedReaderPopover(marked, 'Select this phrase');
    assert.equal(marked.style.getPropertyValue('--popover-left'), '140px');
    assert.equal(marked.style.getPropertyValue('--popover-top'), '260px');
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
    const paragraphs = [...env.root.querySelectorAll('.pc-reader-paragraph')];
    assert.deepEqual(paragraphs.map(paragraph => paragraph.textContent), [
      'Deployed safely. Select this phrase.',
      'Again deploy.'
    ]);
    assert.deepEqual(
      paragraphs.map(paragraph => [...paragraph.querySelectorAll('[data-sentence-index]')]
        .map(node => node.dataset.sentenceIndex)),
      [['0', '1'], ['2']]
    );
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
      contextSentence: 'Select this phrase.'
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
    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
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
    assert.deepEqual([rate.min, rate.max, rate.step, rate.value], ['0.5', '1.5', '0.25', '1']);
    const returningSetRate = speech.controller.setRate;
    speech.controller.setRate = value => { speech.calls.push(['setRate', Number(value)]); };
    for (const value of ['0.75', '1.25']) {
      rate.value = value;
      rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      assert.deepEqual(speech.calls.at(-1), ['setRate', Number(value)]);
      assert.equal(rateValue.textContent, `${value}×`);
    }
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

test('reader exposes one stateful full-reading action and restart only after progress', async () => {
  const env = installDom();
  const speech = createReaderSpeechFake();
  const submissions = [];
  const cleanup = createReaderView({
    root: env.root,
    api: async () => articleDetail(),
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressQueue: {
      submit: async item => { submissions.push(item); return true; },
      retry: async () => true
    },
    progressRuntime: {
      setInterval: () => 1,
      clearInterval() {},
      requestAnimationFrame: callback => callback()
    }
  });
  try {
    await flush();
    const primary = env.root.querySelector('[data-action="speech-primary"]');
    const restart = env.root.querySelector('[data-action="speech-restart"]');
    assert.equal(primary.textContent, '播放');
    assert.equal(restart.hidden, true);
    assert.equal(env.root.querySelector('[data-action="speech-stop"]'), null);

    click(env.window, primary);
    assert.deepEqual(speech.calls.at(-1), ['startAt', 0]);

    speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
    assert.equal(primary.textContent, '暂停');
    assert.equal(restart.hidden, true);
    click(env.window, primary);
    assert.deepEqual(speech.calls.at(-1), ['pause']);

    speech.emit({ state: 'paused', currentIndex: 1, completion: { reachedEnd: false } });
    assert.equal(primary.textContent, '继续');
    assert.equal(restart.hidden, false);
    click(env.window, primary);
    assert.deepEqual(speech.calls.at(-1), ['resume']);

    speech.emit({ state: 'paused', currentIndex: 1, completion: { reachedEnd: false } });
    speech.emit({ state: 'once', currentIndex: null, completion: { reachedEnd: false } });
    assert.equal(primary.textContent, '播放');
    assert.equal(restart.hidden, true);
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: false } });
    assert.equal(primary.textContent, '继续');
    assert.equal(restart.hidden, false);
    click(env.window, restart);
    assert.deepEqual(speech.calls.at(-1), ['startAt', 0]);
    assert.equal(submissions.filter(item => item.kind === 'position').at(-1).lastAloudSentenceIndex, 0);

    speech.emit({
      state: 'idle',
      currentIndex: null,
      completion: { reachedEnd: true },
      completionEvent: { counted: true }
    });
    assert.equal(primary.textContent, '播放');
    assert.equal(restart.hidden, true);
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

    click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
    assert.deepEqual(speech.calls.at(-1), ['startAt', 0]);

    const rate = env.root.querySelector('[data-action="speech-rate"]');
    assert.equal(rate.type, 'range');
    assert.deepEqual([rate.min, rate.max, rate.step, rate.value], ['0.5', '1.5', '0.25', '1']);
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
    speech.emit({ state: 'once', currentIndex: null, completion: { reachedEnd: false, coverage: 0, counted: false } });
    assert.equal(speechStatus.textContent, '正在朗读所选内容');
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: false, coverage: 0, counted: false } });
    assert.equal(speechStatus.textContent, '所选内容朗读结束');
    speech.emit({ state: 'speaking', currentIndex: 0, completion: { reachedEnd: false, coverage: 0, counted: false } });
    speech.emit({ state: 'idle', currentIndex: null, completion: { reachedEnd: true, coverage: 1, counted: true } });
    assert.equal(speechStatus.textContent, '全文朗读完成');
    assert.equal(sentence.classList.contains('pc-sentence-speaking'), false);

    const play = env.root.querySelector('[data-action="speech-primary"]');
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
    progressQueue: { submit: async () => false, retry: async () => false },
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
  let scrollY = 0;
  Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(env.window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(env.window.document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
  const api = async (path, init = {}) => {
    if (path === '/api/articles/a1' && !init.method) return articleDetail({ words: [] });
    if (path === '/api/articles/a1/markings/m1' && init.method === 'DELETE') throw new Error('取消标记失败');
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller,
    progressQueue: {
      submit: async () => outcomes.shift() ?? true,
      retry: async () => true
    },
    progressRuntime: { now: () => 1_000, setInterval: callback => { intervals.push(callback); return callback; }, clearInterval() {}, requestAnimationFrame: callback => callback() }
  });
  try {
    await flush();
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').dataset.errorKind, 'progress');
    scrollY = 250;
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]'), null);
    scrollY = 500;
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').dataset.errorKind, 'progress');
    click(env.window, env.root.querySelector('.pc-term-pending'));
    click(env.window, env.root.querySelector('[data-action="unmark-local"]'));
    await flush();
    scrollY = 750;
    assert.equal(env.root.querySelector('[data-role="reader-error"]').textContent, '取消标记失败');
    intervals[0]();
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]').textContent, '取消标记失败');
    scrollY = 1000;
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
  let scrollY = 0;
  Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(env.window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(env.window.document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
  const cleanup = createReaderView({
    root: env.root,
    api: async (path, init = {}) => {
      if (path === '/api/articles/a1' && !init.method) return articleDetail({ words: [] });
      throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
    },
    articleId: 'a1', navigate() {}, speech: createReaderSpeechFake().controller,
    progressQueue: {
      submit: () => {
        const request = deferred();
        submissions.push(request);
        return request.promise;
      },
      retry: async () => true
    },
    progressRuntime: { setInterval: callback => { intervals.push(callback); return callback; }, clearInterval() {}, requestAnimationFrame: callback => callback() }
  });
  try {
    await flush();
    intervals[0]();
    scrollY = 250;
    intervals[0]();
    submissions[1].resolve(true);
    await flush();
    submissions[0].resolve(false);
    await flush();
    assert.equal(env.root.querySelector('[data-role="reader-error"]'), null);

    scrollY = 500;
    intervals[0]();
    scrollY = 750;
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
    assert.match(env.root.querySelector('[data-role="confirm-dialog"]').textContent, /1 个来源/);
    acceptConfirmation(env.window);
    await flush();
    assert.equal(env.root.querySelector('.pc-inline-error').textContent, '取消失败');
    click(env.window, env.root.querySelector('[data-action="delete-global"]'));
    acceptConfirmation(env.window);
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
    assert.equal(controls.length, 10);
    assert.ok(controls.every(control => control.disabled));
    assert.equal(env.root.querySelector('[data-action="speech-floating-toggle"]').disabled, true);
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

test('pending organizer renders vertically ordered actions with accessible term labels', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const cleanup = createPendingView({
    root: env.root,
    api: async path => {
      if (path === '/api/marked-terms') return [{
        id: 't1',
        display_text: 'practice makes perfect',
        normalized_text: 'practice makes perfect',
        kind: 'phrase',
        source_count: 2,
        created_at: 1,
        context_sentence: 'Practice makes perfect.'
      }];
      throw new Error(`unexpected request GET ${path}`);
    }
  });
  try {
    await flush();
    const row = env.root.querySelector('[data-term-id="t1"]');
    const actions = row.querySelector('.pc-pending-actions');
    assert.ok(actions);
    const buttons = [...actions.querySelectorAll('button')];

    assert.equal(row.classList.contains('pc-card'), false);
    assert.equal(buttons.length, 2);
    assert.deepEqual(buttons.map(node => node.dataset.action), ['convert', 'delete-global']);
    assert.deepEqual(buttons.map(node => node.textContent.trim()), ['收录', '移除']);
    assert.equal(buttons[0].getAttribute('aria-label'), '将 practice makes perfect 收录到记词本');
    assert.equal(buttons[1].getAttribute('aria-label'), '移除 practice makes perfect 的全部标记');
    assert.equal(buttons[0].querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(buttons[1].querySelector('svg').getAttribute('aria-hidden'), 'true');
  } finally {
    cleanup();
    env.restore();
  }
});

test('pending conversion saves selected and newly created tags', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const calls = [];
  const term = {
    id: 't1', display_text: 'deploy', normalized_text: 'deploy',
    kind: 'word', source_count: 1, created_at: 1, context_sentence: 'Deploy it.'
  };
  const api = async (path, init = {}) => {
    calls.push({ path, init });
    if (path === '/api/marked-terms' && !init.method) return [term];
    if (path === '/api/tags' && !init.method) {
      return { tags: [{ id: 'tag-existing', name: '工作' }] };
    }
    if (path === '/api/tags' && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { name: '云平台' });
      return { tag: { id: 'tag-new', name: '云平台' } };
    }
    if (path === '/api/marked-terms/t1/add-to-word' && init.method === 'POST') {
      return { id: 'w1', lemma: 'deploy', zh: '部署', forms: [] };
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="convert"]'));
    await flush();
    const form = env.root.querySelector('[data-role="conversion-form"]');
    assert.equal(form.querySelector('[data-action="submit-conversion"]').textContent, '保存');
    const existing = form.querySelector('input[name="tagIds"][value="tag-existing"]');
    assert.ok(existing);
    existing.checked = true;

    const newTag = form.querySelector('[data-role="new-tag-input"]');
    newTag.value = ' 云平台 ';
    newTag.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true
    }));
    await flush();

    const created = form.querySelector('input[name="tagIds"][value="tag-new"]');
    assert.ok(created);
    assert.equal(created.checked, true);
    assert.equal(form.querySelectorAll('input[name="tagIds"]').length, 2);

    form.elements.zh.value = '部署';
    submit(env.window, form);
    await flush();
    const saveCall = calls.find(call => call.path.endsWith('/add-to-word'));
    assert.deepEqual(JSON.parse(saveCall.init.body).tagIds.sort(), ['tag-existing', 'tag-new']);
  } finally {
    cleanup();
    env.restore();
  }
});

test('pending tag creation deduplicates, reports failure, and ignores a late response', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const lateTag = deferred();
  let attempts = 0;
  const term = {
    id: 't1', display_text: 'deploy', normalized_text: 'deploy',
    kind: 'word', source_count: 1, created_at: 1
  };
  const api = async (path, init = {}) => {
    if (path === '/api/marked-terms' && !init.method) return [term];
    if (path === '/api/tags' && !init.method) {
      return { tags: [{ id: 'tag-existing', name: '工作' }] };
    }
    if (path === '/api/tags' && init.method === 'POST') {
      attempts += 1;
      if (attempts === 1) throw new Error('标签服务暂不可用');
      if (attempts === 2) return { tag: { id: 'tag-existing', name: '工作' } };
      return lateTag.promise;
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${path}`);
  };
  const cleanup = createPendingView({ root: env.root, api });
  try {
    await flush();
    click(env.window, env.root.querySelector('[data-action="convert"]'));
    await flush();
    const form = env.root.querySelector('[data-role="conversion-form"]');
    const input = form.querySelector('[data-role="new-tag-input"]');
    input.value = '工作';
    click(env.window, form.querySelector('[data-action="create-tag"]'));
    await flush();
    assert.equal(form.querySelector('[data-role="tag-error"]').textContent, '标签服务暂不可用');
    assert.equal(input.value, '工作');

    click(env.window, form.querySelector('[data-action="create-tag"]'));
    await flush();
    assert.equal(form.querySelectorAll('input[name="tagIds"][value="tag-existing"]').length, 1);
    assert.equal(form.querySelector('input[value="tag-existing"]').checked, true);

    input.value = '稍后';
    click(env.window, form.querySelector('[data-action="create-tag"]'));
    assert.equal(form.querySelector('[data-action="submit-conversion"]').disabled, true);
    click(env.window, form.querySelector('[data-action="cancel-conversion"]'));
    lateTag.resolve({ tag: { id: 'late', name: '稍后' } });
    await flush();
    assert.equal(env.root.querySelector('[data-role="conversion-form"]'), null);
  } finally {
    cleanup();
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
      zh: '发布', lemma: 'deploy', example: 'Edited before merge.', stress: '',
      tagIds: [], strategy: 'merge', targetWordId: 'w1'
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
    assert.match(env.root.querySelector('[data-role="confirm-dialog"]').textContent, /1 个来源/);
    acceptConfirmation(env.window);
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
    assert.equal(env.root.querySelector('.pc-module-tab.active').getAttribute('aria-current'), 'page');
    assert.equal(env.root.querySelector('.pc-article-nav-link.active').getAttribute('aria-current'), 'page');

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
    assert.match(env.root.textContent, /词库/);
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

test('reader cleanup removes click, pointer, selectionchange, and document key listeners', async () => {
  const env = installDom();
  let navigations = 0;
  let cleared = 0;
  const timeouts = controlledTimeouts();
  const api = async path => {
    if (path === '/api/articles/a1') return articleDetail();
    throw new Error(`unexpected request ${path}`);
  };
  const cleanup = createReaderView({
    root: env.root, api, articleId: 'a1', navigate: () => { navigations += 1; },
    speech: { isSupported: true, speakOnce() {}, load() {}, startAt() {}, pause() {}, resume() {}, setRate() {}, getRate: () => 1, subscribe: () => () => {}, stop() {} },
    progressRuntime: timeouts.runtime
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
    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
    assert.equal(timeouts.tasks.size, 1);
    cleanup();
    assert.equal(cleared, 1);
    assert.equal(timeouts.tasks.size, 0);

    click(env.window, back);
    click(env.window, term);
    sentence.dispatchEvent(new env.window.MouseEvent('pointerup', { bubbles: true }));
    env.window.document.dispatchEvent(new env.window.Event('selectionchange'));
    assert.equal(timeouts.tasks.size, 0);
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
    progressQueue: {
      submit: async item => { submitted.push(item); return true; },
      retry: async () => true
    },
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

test('reader skips unchanged position snapshots while preserving active-time events', async () => {
  const env = installDom();
  let now = 0;
  let scrollY = 0;
  const submitted = [];
  const intervals = [];
  const speech = createReaderSpeechFake();
  Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(env.window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(env.window.document.documentElement, 'scrollHeight', {
    configurable: true, get: () => 2000
  });
  Object.defineProperty(env.window.document, 'visibilityState', {
    configurable: true, value: 'visible'
  });
  env.window.scrollTo = ({ top }) => { scrollY = top; };
  const cleanup = createReaderView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles/a1') {
        return articleDetail({ progress: { last_position_ratio: 0 } });
      }
      throw new Error(`unexpected request ${path}`);
    },
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressQueue: {
      submit: async item => { submitted.push(item); return true; },
      retry: async () => true
    },
    progressRuntime: {
      now: () => now,
      setInterval: callback => { intervals.push(callback); return callback; },
      clearInterval() {},
      requestAnimationFrame: callback => callback()
    }
  });
  try {
    await flush();
    env.window.dispatchEvent(new env.window.Event('scroll'));
    now = 5_000;
    intervals[0]();
    now = 10_000;
    intervals[0]();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 1);
    assert.equal(submitted.filter(item => item.event?.type === 'active_ms').length, 2);

    Object.defineProperty(env.window.document, 'visibilityState', {
      configurable: true, value: 'hidden'
    });
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    Object.defineProperty(env.window.document, 'visibilityState', {
      configurable: true, value: 'visible'
    });
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    assert.equal(submitted.filter(item => item.kind === 'position').length, 1);

    scrollY = 500;
    intervals[0]();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 2);

    speech.emit({ state: 'paused', currentIndex: 1 });
    await Promise.resolve();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 3);

    cleanup();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 3);
  } finally {
    env.restore();
  }
});

test('reader retries one persisted failed position when the next snapshot is unchanged', async () => {
  const env = installDom();
  let fail = true;
  const attempts = [];
  const intervals = [];
  Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(env.window, 'scrollY', { configurable: true, value: 0 });
  Object.defineProperty(env.window.document.documentElement, 'scrollHeight', {
    configurable: true, value: 2000
  });
  const progressQueue = createProgressQueue({
    storage: env.window.localStorage,
    send: async item => {
      attempts.push(item);
      if (fail) throw new Error('offline');
    }
  });
  const cleanup = createReaderView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles/a1') {
        return articleDetail({ progress: { last_position_ratio: 0 } });
      }
      throw new Error(`unexpected request ${path}`);
    },
    articleId: 'a1',
    navigate() {},
    speech: createReaderSpeechFake().controller,
    progressQueue,
    progressRuntime: {
      setInterval: callback => { intervals.push(callback); return callback; },
      clearInterval() {},
      requestAnimationFrame: callback => callback()
    }
  });
  try {
    await flush();
    intervals[0]();
    await flush();
    assert.equal(attempts.length, 1);
    assert.equal(progressQueue.snapshot().length, 1);
    assert.equal(progressQueue.snapshot()[0].kind, 'position');
    assert.equal(JSON.parse(env.window.localStorage.getItem(PROGRESS_QUEUE_KEY)).length, 1);
    assert.equal(env.root.querySelector('[data-role="reader-error"]').dataset.errorKind, 'progress');

    fail = false;
    intervals[0]();
    await flush();
    assert.equal(attempts.length, 2);
    assert.deepEqual(progressQueue.snapshot(), []);
    assert.equal(env.window.localStorage.getItem(PROGRESS_QUEUE_KEY), null);
    assert.equal(env.root.querySelector('[data-role="reader-error"]'), null);
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
