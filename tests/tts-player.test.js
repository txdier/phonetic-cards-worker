import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtsPlayer } from '../public/lib/tts-player.js';

test('TTS player falls back to browser speech when cloud audio is unavailable', async () => {
  const spoken = [];
  const player = createTtsPlayer({
    fetch: async () => new Response(
      JSON.stringify({ fallback: 'web-speech' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    ),
    fallback: {
      isSupported: true,
      speakOnce: (...args) => spoken.push(args),
      stop() {}
    }
  });

  await player.speakWord('w1', 'word', 'confirm', { rate: 0.8 });

  assert.deepEqual(spoken, [['confirm', { rate: 0.8 }]]);
});

test('TTS player invalidates a pending cloud request when stopped', async () => {
  let resolveFetch;
  let constructed = 0;
  const spoken = [];
  const player = createTtsPlayer({
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
    Audio: class { constructor() { constructed += 1; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fallback: { isSupported: true, speakOnce: text => spoken.push(text), stop() {} }
  });

  const pending = player.speakWord('w1', 'word', 'confirm');
  player.stop();
  resolveFetch(new Response(new Uint8Array([1]), { status: 200 }));
  await pending;

  assert.equal(constructed, 0);
  assert.deepEqual(spoken, []);
});

test('TTS player reads an article sentence-by-sentence and prefetches only the next sentence', async () => {
  const paths = [];
  const states = [];
  class FakeAudio {
    constructor() { this.playbackRate = 1; }
    play() {
      this.onplay?.();
      queueMicrotask(() => this.onended?.());
      return Promise.resolve();
    }
    pause() {}
  }
  const player = createTtsPlayer({
    fetch: async path => {
      paths.push(path);
      return new Response(new Uint8Array([1]), { status: 200 });
    },
    Audio: FakeAudio,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fallback: { isSupported: true, stop() {}, load() {}, startAt() {} }
  });

  const completed = await player.startArticle('a1', ['First.', 'Second.'], 0, {
    onState: state => states.push(state)
  });

  assert.equal(completed, true);
  assert.equal(paths.filter(path => path.endsWith('/sentences/0')).length, 1);
  assert.ok(paths.filter(path => path.endsWith('/sentences/1')).length <= 2);
  assert.equal(states.at(-1).completionEvent.counted, true);
});

test('article completion remains counted after a mid-sequence browser fallback', async () => {
  const states = [];
  const subscribers = new Set();
  class FakeAudio {
    play() {
      this.onplay?.();
      queueMicrotask(() => this.onended?.());
      return Promise.resolve();
    }
    pause() {}
  }
  const fallback = {
    isSupported: true,
    stop() {},
    load() {},
    setRate() {},
    subscribe(callback) {
      subscribers.add(callback);
      callback({ state: 'idle', completion: { reachedEnd: false } });
      return () => subscribers.delete(callback);
    },
    startAt() {
      for (const callback of subscribers) {
        callback({
          state: 'idle',
          completion: { reachedEnd: true, coverage: 1, counted: false }
        });
      }
    }
  };
  const player = createTtsPlayer({
    fetch: async path => path.endsWith('/sentences/0')
      ? new Response(new Uint8Array([1]), { status: 200 })
      : new Response('', { status: 503 }),
    Audio: FakeAudio,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fallback
  });

  await player.startArticle('a1', ['First.', 'Second.'], 0, {
    onState: state => states.push(state)
  });

  assert.equal(states.at(-1).completionEvent.counted, true);
});
