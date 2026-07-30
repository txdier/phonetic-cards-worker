import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSessionBridge } from '../public/lib/media-session.js';

function createMediaSession({ unsupported = [] } = {}) {
  const actions = new Map();
  return {
    actions,
    mediaSession: {
      setActionHandler(name, handler) {
        if (unsupported.includes(name)) throw new Error(`Unsupported action: ${name}`);
        actions.set(name, handler);
      },
      metadata: null,
      playbackState: 'none'
    }
  };
}

const MediaMetadata = class {
  constructor(value) { Object.assign(this, value); }
};

test('media session maps previous current and next independently', () => {
  const { actions, mediaSession } = createMediaSession();
  const calls = [];
  const bridge = createMediaSessionBridge({ mediaSession, MediaMetadata });
  bridge.bind({
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    previous: () => calls.push('previous'),
    current: () => calls.push('current'),
    next: () => calls.push('next')
  });

  bridge.update({
    state: 'speaking', currentIndex: 1, sentenceCount: 3,
    title: 'Article', author: 'Author', sentence: 'Second.'
  });
  actions.get('previoustrack')();
  actions.get('seekbackward')();
  actions.get('nexttrack')();

  assert.deepEqual(calls, ['previous', 'current', 'next']);
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(mediaSession.metadata.title, 'Article');
  assert.equal(mediaSession.metadata.artist, 'Author');
  assert.equal(mediaSession.metadata.album, 'Second.');
});

test('media session clears previous track at the first sentence and restores it later', () => {
  const { actions, mediaSession } = createMediaSession();
  const bridge = createMediaSessionBridge({ mediaSession, MediaMetadata });
  bridge.bind({ previous() {} });

  bridge.update({ state: 'paused', currentIndex: 0, sentenceCount: 2 });
  assert.equal(actions.get('previoustrack'), null);
  assert.equal(mediaSession.playbackState, 'paused');

  bridge.update({ state: 'idle', currentIndex: 1, sentenceCount: 2 });
  assert.equal(typeof actions.get('previoustrack'), 'function');
  assert.equal(mediaSession.playbackState, 'none');
});

test('media session clears next track at the last sentence and restores it earlier', () => {
  const { actions, mediaSession } = createMediaSession();
  const bridge = createMediaSessionBridge({ mediaSession, MediaMetadata });
  bridge.bind({ next() {} });

  bridge.update({ state: 'speaking', currentIndex: 2, sentenceCount: 3 });
  assert.equal(actions.get('nexttrack'), null);

  bridge.update({ state: 'speaking', currentIndex: 1, sentenceCount: 3 });
  assert.equal(typeof actions.get('nexttrack'), 'function');
});

test('an unsupported action does not block other media session controls', () => {
  const { actions, mediaSession } = createMediaSession({ unsupported: ['seekbackward'] });
  const calls = [];
  const bridge = createMediaSessionBridge({ mediaSession, MediaMetadata });

  bridge.bind({
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    previous: () => calls.push('previous'),
    current: () => calls.push('current'),
    next: () => calls.push('next')
  });

  actions.get('play')();
  actions.get('pause')();
  actions.get('previoustrack')();
  actions.get('nexttrack')();

  assert.deepEqual(calls, ['play', 'pause', 'previous', 'next']);
  assert.equal(actions.has('seekbackward'), false);
});

test('media session update is capability-gated and cleanup clears registered controls and metadata', () => {
  const { actions, mediaSession } = createMediaSession();
  const bridge = createMediaSessionBridge({ mediaSession });
  bridge.bind({ play() {}, pause() {}, previous() {}, current() {}, next() {} });

  bridge.update({ state: 'unknown', currentIndex: 0, sentenceCount: 1 });
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(mediaSession.metadata, null);

  bridge.cleanup();

  assert.deepEqual([...actions.entries()], [
    ['play', null],
    ['pause', null],
    ['previoustrack', null],
    ['seekbackward', null],
    ['nexttrack', null]
  ]);
  assert.equal(mediaSession.metadata, null);
});

test('a playback update after cleanup rebinds every control for replay or a new session', () => {
  const { actions, mediaSession } = createMediaSession();
  const calls = [];
  const bridge = createMediaSessionBridge({ mediaSession, MediaMetadata });
  bridge.bind({
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    previous: () => calls.push('previous'),
    current: () => calls.push('current'),
    next: () => calls.push('next')
  });
  bridge.cleanup();

  bridge.update({
    state: 'speaking', currentIndex: 1, sentenceCount: 3,
    title: 'Replay', author: 'Author', sentence: 'Second.'
  });

  for (const action of ['play', 'pause', 'previoustrack', 'seekbackward', 'nexttrack']) {
    assert.equal(typeof actions.get(action), 'function', action);
  }
  actions.get('play')();
  actions.get('seekbackward')();
  assert.deepEqual(calls, ['play', 'current']);
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(mediaSession.metadata.title, 'Replay');
});

test('media session is safe when the API is unavailable', () => {
  const bridge = createMediaSessionBridge();

  assert.doesNotThrow(() => {
    bridge.bind({ play() {}, pause() {}, previous() {}, current() {}, next() {} });
    bridge.update({ state: 'speaking', currentIndex: 0, sentenceCount: 1 });
    bridge.cleanup();
  });
});
