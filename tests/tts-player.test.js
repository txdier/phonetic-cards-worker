import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtsPlayer } from '../public/lib/tts-player.js';

class ControlledAudio {
  constructor() {
    this.currentTime = 0;
    this.duration = 0;
    this.playbackRate = 1;
    this.sourceCount = 0;
    this.sourceWaiters = [];
  }

  set src(value) {
    this._src = value;
    this.sourceCount += 1;
    for (const waiter of [...this.sourceWaiters]) {
      if (this.sourceCount >= waiter.count) {
        this.sourceWaiters.splice(this.sourceWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  get src() { return this._src; }

  play() {
    this.playCalls = (this.playCalls || 0) + 1;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls = (this.pauseCalls || 0) + 1;
  }

  waitForSource(count = this.sourceCount + 1) {
    if (this.sourceCount >= count) return Promise.resolve();
    return new Promise(resolve => this.sourceWaiters.push({ count, resolve }));
  }

  async metadata({ duration }) {
    this.duration = duration;
    this.onloadedmetadata?.();
    await Promise.resolve();
  }

  async begin() {
    this.onplay?.();
    await Promise.resolve();
  }

  async timeupdate(currentTime) {
    this.currentTime = currentTime;
    this.ontimeupdate?.();
    await Promise.resolve();
  }

  async finish() {
    this.onended?.();
    await Promise.resolve();
  }
}

function fakeUrlApi() {
  let nextId = 0;
  return {
    createObjectURL() { return `blob:test-${nextId += 1}`; },
    revokeObjectURL() {}
  };
}

function fakeFallback(overrides = {}) {
  return {
    isSupported: true,
    stop() {},
    load() {},
    startAt() {},
    pause() {},
    resume() {},
    setRate() {},
    ...overrides
  };
}

function cloudResponse() {
  return new Response(new Uint8Array([1]), { status: 200 });
}

test('article playback reuses one audio and changes current only on play', async () => {
  const audio = new ControlledAudio();
  let constructions = 0;
  const states = [];
  const player = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class {
      constructor() {
        constructions += 1;
        return audio;
      }
    },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });
  player.subscribe(state => states.push(state));

  const playback = player.startArticle('a1', ['One.', 'Two.'], 0);
  await audio.waitForSource();
  assert.equal(states.at(-1).currentIndex, null);
  await audio.begin();
  assert.equal(states.at(-1).currentIndex, 0);
  await audio.finish();
  await audio.waitForSource(2);
  assert.equal(states.at(-1).currentIndex, 0);
  await audio.begin();
  assert.equal(states.at(-1).currentIndex, 1);
  await audio.finish();
  await playback;
  assert.equal(constructions, 1);
});

test('replay current sentence targets the audible sentence', async () => {
  const audio = new ControlledAudio();
  const paths = [];
  const player = createTtsPlayer({
    fetch: async path => {
      paths.push(path);
      return cloudResponse();
    },
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.', 'Two.'], 1);
  await audio.waitForSource();
  await audio.begin();

  assert.equal(player.replayCurrentSentence(), true);
  await audio.waitForSource(2);
  assert.match(paths.at(-1), /\/sentences\/1$/);
});

test('previous sentence targets the sentence before the audible sentence', async () => {
  const audio = new ControlledAudio();
  const paths = [];
  const player = createTtsPlayer({
    fetch: async path => {
      paths.push(path);
      return cloudResponse();
    },
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.', 'Two.'], 1);
  await audio.waitForSource();
  await audio.begin();

  assert.equal(player.previousSentence(), true);
  await audio.waitForSource(2);
  assert.match(paths.at(-1), /\/sentences\/0$/);
  await audio.begin();
  await audio.finish();
  await audio.waitForSource(3);
  assert.match(paths.at(-1), /\/sentences\/1$/);
});

test('the last audible sentence remains replayable after article completion', async () => {
  const audio = new ControlledAudio();
  const paths = [];
  const player = createTtsPlayer({
    fetch: async path => {
      paths.push(path);
      return cloudResponse();
    },
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  const playback = player.startArticle('a1', ['One.'], 0);
  await audio.waitForSource();
  await audio.begin();
  await audio.finish();
  await playback;

  assert.equal(player.replayCurrentSentence(), true);
  await audio.waitForSource(2);
  assert.match(paths.at(-1), /\/sentences\/0$/);
  assert.equal(audio.playCalls, 2);
});

test('previous sentence is unavailable at the first audible sentence', async () => {
  const audio = new ControlledAudio();
  const firstSentencePlayer = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void firstSentencePlayer.startArticle('a1', ['One.', 'Two.'], 0);
  await audio.waitForSource();
  await audio.begin();

  assert.equal(firstSentencePlayer.previousSentence(), false);
});

test('next sentence targets the sentence after the audible sentence', async () => {
  const audio = new ControlledAudio();
  const paths = [];
  const player = createTtsPlayer({
    fetch: async path => {
      paths.push(path);
      return cloudResponse();
    },
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.', 'Two.'], 0);
  await audio.waitForSource();
  await audio.begin();

  assert.equal(player.nextSentence(), true);
  await audio.waitForSource(2);
  assert.match(paths.at(-1), /\/sentences\/1$/);
  await audio.begin();
  assert.equal(player.nextSentence(), false);
});

test('article offset is applied after metadata and clamped to duration', async () => {
  const offsetAudio = new ControlledAudio();
  const player = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class { constructor() { return offsetAudio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.'], 0, { offsetSeconds: 2.5 });
  await offsetAudio.waitForSource();
  assert.equal(offsetAudio.playCalls || 0, 0);
  await offsetAudio.metadata({ duration: 8 });

  assert.equal(offsetAudio.currentTime, 2.5);
  assert.equal(offsetAudio.playCalls, 1);
});

test('article offset cannot seek past the loaded duration', async () => {
  const audio = new ControlledAudio();
  const player = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.'], 0, { offsetSeconds: 12 });
  await audio.waitForSource();
  await audio.metadata({ duration: 0 });

  assert.equal(audio.currentTime, 0);
});

test('pause is immediate and resume preserves the media position', async () => {
  const audio = new ControlledAudio();
  const player = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.'], 0);
  await audio.waitForSource();
  await audio.begin();
  await audio.timeupdate(1.75);
  const pausesBeforeUserPause = audio.pauseCalls || 0;
  player.pause();
  const pausedAt = audio.currentTime;
  player.resume();

  assert.equal(audio.currentTime, pausedAt);
  assert.equal(audio.pauseCalls, pausesBeforeUserPause + 1);
  assert.equal(audio.playCalls, 2);
  assert.equal(player.getSnapshot().state, 'paused');
  await audio.begin();
  assert.equal(player.getSnapshot().state, 'speaking');
});

test('point and article playback share the same audio construction', async () => {
  const audio = new ControlledAudio();
  let constructionsAfterPointAndArticle = 0;
  const player = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class {
      constructor() {
        constructionsAfterPointAndArticle += 1;
        return audio;
      }
    },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  const point = player.speakWord('w1', 'word', 'confirm');
  await audio.waitForSource();
  await audio.begin();
  await audio.finish();
  await point;
  void player.startArticle('a1', ['One.'], 0);
  await audio.waitForSource(2);

  assert.equal(constructionsAfterPointAndArticle, 1);
});

test('stopping an unused player does not pause an empty media element', () => {
  const audio = new ControlledAudio();
  const player = createTtsPlayer({
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  player.stop();

  assert.equal(audio.pauseCalls || 0, 0);
});

test('cloud failure publishes fallback state', async () => {
  const player = createTtsPlayer({
    fetch: async () => new Response('', { status: 503 }),
    Audio: ControlledAudio,
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  await player.startArticle('a1', ['One.'], 0);

  assert.equal(player.getSnapshot().fallbackActive, true);
});

test('article completion remains counted after a mid-sequence browser fallback', async () => {
  const audio = new ControlledAudio();
  const states = [];
  const subscribers = new Set();
  const fallback = fakeFallback({
    subscribe(callback) {
      subscribers.add(callback);
      callback({ state: 'idle', currentIndex: null, completion: { reachedEnd: false, coverage: 0 } });
      return () => subscribers.delete(callback);
    },
    startAt(index) {
      for (const callback of subscribers) {
        callback({
          state: 'speaking',
          currentIndex: index,
          completion: { reachedEnd: false, coverage: 0.5, counted: false }
        });
        callback({
          state: 'idle',
          currentIndex: null,
          completion: { reachedEnd: true, coverage: 1, counted: false },
          completionEvent: { reachedEnd: true, coverage: 1, counted: false }
        });
      }
    }
  });
  const player = createTtsPlayer({
    fetch: async path => path.endsWith('/sentences/0')
      ? cloudResponse()
      : new Response('', { status: 503 }),
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback
  });
  player.subscribe(state => states.push(state));

  const playback = player.startArticle('a1', ['First.', 'Second.'], 0);
  await audio.waitForSource();
  await audio.begin();
  await audio.finish();
  await playback;

  assert.equal(states.at(-1).completionEvent.counted, true);
  assert.equal(states.at(-1).fallbackActive, true);
});

test('article onState remains subscribed through asynchronous fallback completion', async () => {
  let fallbackCallback;
  const states = [];
  const fallback = fakeFallback({
    subscribe(callback) {
      fallbackCallback = callback;
      callback({ state: 'idle', currentIndex: null, completion: { reachedEnd: false, coverage: 0 } });
      return () => { fallbackCallback = null; };
    }
  });
  const player = createTtsPlayer({
    fetch: async () => new Response('', { status: 503 }),
    Audio: ControlledAudio,
    URL: fakeUrlApi(),
    fallback
  });

  await player.startArticle('a1', ['One.'], 0, {
    onState: next => states.push(next)
  });
  fallbackCallback?.({
    state: 'idle',
    currentIndex: null,
    completion: { reachedEnd: true, coverage: 1, counted: false },
    completionEvent: { reachedEnd: true, coverage: 1, counted: false }
  });

  assert.equal(states.at(-1).completionEvent.counted, true);
});

test('replay stops active fallback before returning to cloud audio', async () => {
  const audio = new ControlledAudio();
  let fetchCount = 0;
  let fallbackCallback;
  let fallbackStops = 0;
  let fallbackUnsubscribes = 0;
  let fallbackPauses = 0;
  const fallback = fakeFallback({
    stop() { fallbackStops += 1; },
    pause() { fallbackPauses += 1; },
    subscribe(callback) {
      fallbackCallback = callback;
      return () => {
        fallbackCallback = null;
        fallbackUnsubscribes += 1;
      };
    },
    startAt(index) {
      fallbackCallback?.({
        state: 'speaking',
        currentIndex: index,
        completion: { reachedEnd: false, coverage: 0, counted: false }
      });
    }
  });
  const player = createTtsPlayer({
    fetch: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? new Response('', { status: 503 })
        : cloudResponse();
    },
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback
  });

  await player.startArticle('a1', ['One.'], 0);
  const stopsBeforeReplay = fallbackStops;
  assert.equal(player.replayCurrentSentence(), true);
  await audio.waitForSource();
  await audio.begin();
  const pausesBeforeUserPause = audio.pauseCalls || 0;
  player.pause();

  assert.equal(fallbackStops, stopsBeforeReplay + 1);
  assert.equal(fallbackUnsubscribes, 1);
  assert.equal(player.getSnapshot().fallbackActive, false);
  assert.equal(audio.pauseCalls, pausesBeforeUserPause + 1);
  assert.equal(fallbackPauses, 0);
});

test('stale media callbacks cannot promote or advance a newer request', async () => {
  const audio = new ControlledAudio();
  const player = createTtsPlayer({
    fetch: async () => cloudResponse(),
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.', 'Two.', 'Three.'], 0);
  await audio.waitForSource();
  const stalePlay = audio.onplay;
  const staleEnded = audio.onended;
  void player.startArticle('a2', ['New one.', 'New two.'], 0);
  await audio.waitForSource(2);

  stalePlay();
  staleEnded();

  assert.equal(player.getSnapshot().currentIndex, null);
  assert.equal(player.getSnapshot().pendingIndex, 0);
  await audio.begin();
  assert.equal(player.getSnapshot().currentIndex, 0);
});

test('stopping a pending cloud request neither plays nor falls back', async () => {
  let resolveFetch;
  const audio = new ControlledAudio();
  const spoken = [];
  const player = createTtsPlayer({
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(),
    fallback: fakeFallback({ speakOnce: text => spoken.push(text) })
  });

  const pending = player.speakWord('w1', 'word', 'confirm');
  player.stop();
  resolveFetch(cloudResponse());
  await pending;

  assert.equal(audio.sourceCount, 0);
  assert.deepEqual(spoken, []);
});

test('TTS player falls back to browser speech when cloud audio is unavailable', async () => {
  const spoken = [];
  const player = createTtsPlayer({
    fetch: async () => new Response(
      JSON.stringify({ fallback: 'web-speech' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    ),
    fallback: fakeFallback({
      speakOnce: (...args) => spoken.push(args)
    })
  });

  await player.speakWord('w1', 'word', 'confirm', { rate: 0.8 });

  assert.deepEqual(spoken, [['confirm', { rate: 0.8 }]]);
});
