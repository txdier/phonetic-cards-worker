import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpeechController } from '../public/lib/speech.js';

function createFakeSpeech(voices = [{ name: 'US', lang: 'en-US' }]) {
  const spoken = [];
  let active = null;
  let pauses = 0;
  let resumes = 0;
  let cancels = 0;
  let paused = false;
  const listeners = new Set();
  const started = new Set();

  class Utterance {
    constructor(text) { this.text = text; }
  }

  const speechSynthesis = {
    get paused() { return paused; },
    getVoices: () => voices,
    speak(utterance) {
      active = utterance;
      spoken.push(utterance);
      if (!paused) {
        started.add(utterance);
        utterance.onstart?.();
      }
    },
    cancel() { cancels += 1; active = null; },
    pause() { pauses += 1; paused = true; },
    resume() {
      resumes += 1;
      paused = false;
      if (active && !started.has(active)) {
        started.add(active);
        active.onstart?.();
      }
    },
    addEventListener(type, listener) { if (type === 'voiceschanged') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'voiceschanged') listeners.delete(listener); }
  };

  return {
    dependencies: { speechSynthesis, Utterance },
    spoken,
    get active() { return active; },
    get pauses() { return pauses; },
    get resumes() { return resumes; },
    get cancels() { return cancels; },
    get paused() { return paused; },
    get voiceListeners() { return listeners.size; },
    setVoices(next) { voices = next; for (const listener of listeners) listener(); },
    end(utterance = active) {
      if (active === utterance) active = null;
      utterance?.onend?.();
    },
    error(utterance = active) {
      if (active === utterance) active = null;
      utterance?.onerror?.({ error: 'synthetic' });
    },
    finishAll() { while (active) this.end(active); }
  };
}

test('reports unsupported dependencies without throwing', () => {
  const controller = createSpeechController({ speechSynthesis: null, Utterance: null });
  assert.equal(controller.isSupported, false);
  assert.doesNotThrow(() => controller.speakOnce('safe'));
  assert.doesNotThrow(() => controller.startAt(0));
});

test('starting after the first sentence reaches the end without counting a full reading', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  const states = [];
  controller.subscribe(state => states.push(state));
  controller.load(['one', 'two', 'three', 'four', 'five']);
  controller.startAt(1);
  fake.finishAll();

  assert.deepEqual(controller.getCompletion(), { reachedEnd: true, coverage: 0.8, counted: false });
  assert.equal(states.filter(state => state.completionEvent).length, 0);
  assert.equal(states.at(-1).state, 'idle');
});

test('starting at sentence three of five reaches the end without counting', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two', 'three', 'four', 'five']);
  controller.startAt(2);
  fake.finishAll();
  assert.deepEqual(controller.getCompletion(), { reachedEnd: true, coverage: 0.6, counted: false });
});

test('errors and stop never complete or advance a reading session', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two']);
  controller.startAt(0);
  fake.error();
  assert.equal(fake.spoken.length, 1);
  assert.deepEqual(controller.getCompletion(), { reachedEnd: false, coverage: 0, counted: false });

  controller.startAt(0);
  const stopped = fake.active;
  controller.stop();
  fake.end(stopped);
  assert.equal(fake.spoken.length, 2);
  assert.deepEqual(controller.getCompletion(), { reachedEnd: false, coverage: 0, counted: false });
});

test('pause and resume delegate and publish state', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  const states = [];
  controller.subscribe(state => states.push(state.state));
  controller.load(['one']);
  controller.startAt(0);
  controller.pause();
  controller.resume();
  assert.equal(fake.pauses, 1);
  assert.equal(fake.resumes, 1);
  assert.deepEqual(states.slice(-2), ['paused', 'speaking']);
});

test('pause then stop clears engine pause so a later reading starts', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  const states = [];
  controller.subscribe(next => states.push(next.state));
  controller.load(['one']);
  controller.startAt(0);
  controller.pause();
  controller.stop();
  controller.startAt(0);
  assert.equal(fake.paused, false);
  assert.equal(states.at(-1), 'speaking');
});

test('pause then speakOnce clears engine pause and starts the one-shot utterance', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  const states = [];
  controller.subscribe(next => states.push(next.state));
  controller.load(['one']);
  controller.startAt(0);
  controller.pause();
  controller.speakOnce('word');
  assert.equal(fake.paused, false);
  assert.equal(fake.active.text, 'word');
  assert.equal(states.at(-1), 'once');
});

test('changing rate while paused clears engine pause and starts the replacement', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  const states = [];
  controller.subscribe(next => states.push(next.state));
  controller.load(['one']);
  controller.startAt(0);
  controller.pause();
  controller.setRate(1.5);
  assert.equal(fake.paused, false);
  assert.equal(fake.active.text, 'one');
  assert.equal(fake.active.rate, 1.5);
  assert.equal(states.at(-1), 'speaking');
});

test('rate clamps and restarts the current sentence while stale callbacks are ignored', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two']);
  controller.startAt(0);
  const stale = fake.active;
  controller.setRate(9);
  const restarted = fake.active;

  assert.equal(controller.getRate(), 1.5);
  assert.notEqual(restarted, stale);
  assert.equal(restarted.text, 'one');
  assert.equal(restarted.rate, 1.5);
  fake.end(stale);
  assert.equal(fake.active, restarted);
  assert.equal(fake.spoken.length, 2);
  fake.end(restarted);
  assert.equal(fake.active.text, 'two');
  fake.finishAll();
  assert.equal(controller.getCompletion().coverage, 1);

  controller.setRate(-5);
  assert.equal(controller.getRate(), 0.5);
});

test('load canonicalizes non-empty sentences so coverage ignores blank entries', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load([' one ', '', '   ', 'two']);
  controller.startAt(0);
  fake.finishAll();
  assert.deepEqual(fake.spoken.map(item => item.text), ['one', 'two']);
  assert.deepEqual(controller.getCompletion(), { reachedEnd: true, coverage: 1, counted: true });
});

test('startAt rejects a non-integer sentence index', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two']);
  controller.startAt(0.5);
  assert.equal(fake.spoken.length, 0);
});

test('speakOnce interrupts sequencing and stale callbacks cannot count or advance it', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two']);
  controller.startAt(0);
  const stale = fake.active;
  controller.speakOnce('selected phrase');
  const once = fake.active;

  assert.equal(once.text, 'selected phrase');
  fake.end(stale);
  assert.equal(fake.active, once);
  fake.end(once);
  assert.equal(fake.spoken.length, 2);
  assert.deepEqual(controller.getCompletion(), { reachedEnd: false, coverage: 0, counted: false });
});

test('interrupting speakOnce settles the prior one-shot cleanup callback', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  let ended = 0;
  controller.speakOnce('first', { onEnd: () => { ended += 1; } });
  controller.speakOnce('second');
  assert.equal(ended, 1);
});

test('prefers exact en-US, refreshes voices, falls back to English then language only, and cleans up', () => {
  const fake = createFakeSpeech([{ name: 'UK', lang: 'en-GB' }, { name: 'US', lang: 'en-us' }]);
  const controller = createSpeechController(fake.dependencies);
  assert.equal(fake.voiceListeners, 1);
  controller.speakOnce('first');
  assert.equal(fake.active.voice.name, 'US');
  assert.equal(fake.active.lang, 'en-us');

  fake.setVoices([{ name: 'UK', lang: 'en-GB' }]);
  controller.speakOnce('second');
  assert.equal(fake.active.voice.name, 'UK');

  fake.setVoices([{ name: 'ZH', lang: 'zh-CN' }]);
  controller.speakOnce('third');
  assert.equal(fake.active.voice, undefined);
  assert.equal(fake.active.lang, 'en-US');
  controller.cleanup();
  assert.equal(fake.voiceListeners, 0);
});
