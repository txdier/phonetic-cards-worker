# Mobile Background Aloud, Timer, and Sentence Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make article read-aloud resilient on locked mobile browsers, restore sentence-level and in-sentence progress, pause on a sleep timer, and expose separate previous-sentence and current-sentence replay controls.

**Architecture:** Keep one application-lifetime `HTMLAudioElement` inside `createTtsPlayer`, and make it the authoritative read-aloud state machine. Add focused modules for local checkpoints, the wall-clock sleep timer, and Media Session integration; keep the reader view responsible for orchestration and rendering. Persist sentence index plus offset atomically to local storage and D1 while retaining the current per-sentence Azure/R2 cache.

**Tech Stack:** Cloudflare Workers, D1 migrations, R2-backed Azure TTS, native JavaScript ES modules, HTMLMediaElement, Media Session API, localStorage, Node.js test runner, JSDOM.

## Global Constraints

- Target both iPhone Safari and Android Chrome.
- Reuse one `HTMLAudioElement`; do not add whole-article audio, HLS, Media Source, a native app, or a new frontend dependency.
- “Current sentence” changes only when its audio actually begins playing, never during prefetch, URL assignment, or buffering.
- “Previous sentence” starts at `currentIndex - 1`; “current sentence” starts at `currentIndex`; both continue forward afterward.
- The sleep timer offers 10, 20, 30, and 60 minutes plus a positive integer custom duration, and pauses immediately at its absolute deadline.
- Mobile web cannot promise native-app background wakeups; if suspended, enforce an expired deadline on the next media event or page activation.
- Preserve Azure/R2 per-sentence caching, Web Speech fallback, rate controls, ordinary sentence click-to-speak, completion counting, keyboard access, dark/light themes, and progress retry behavior.
- Every primary mobile control has a minimum `44px` touch height and the four-control capsule must not overflow at `320px`.
- Real-device lock-screen verification on iPhone Safari and Android Chrome remains a user-run completion gate.

## File Map

- Create `migrations/0008_add_article_aloud_offset.sql`: D1 sentence-offset storage.
- Create `public/lib/aloud-checkpoint.js`: body fingerprinting and user/article-scoped local checkpoints.
- Create `public/lib/sleep-timer.js`: persistent absolute-deadline timer.
- Create `public/lib/media-session.js`: optional OS media action adapter.
- Create `tests/aloud-checkpoint.test.js`, `tests/sleep-timer.test.js`, and `tests/media-session.test.js`: focused module tests.
- Modify `public/lib/tts-player.js` and `tests/tts-player.test.js`: reusable media element and deterministic sentence replay state machine.
- Modify `public/lib/reading-session.js` and `tests/reading-session.test.js`: atomic sentence-index/offset progress queue payload.
- Modify `src/progress-api.js`, `src/articles-api.js`, API tests, and `tests/helpers/sqlite-db.js`: persist, return, validate, and clear offsets.
- Modify `public/app.js`, `public/articles-view.js`, `public/reader-view.js`, `public/styles.css`, and reader/static tests: application wiring, controls, recovery, and responsive UI.
- Modify `README.md`: document background capability, timer, replay controls, and browser limits.

---

### Task 1: Persist sentence offsets atomically in D1

**Files:**
- Create: `migrations/0008_add_article_aloud_offset.sql`
- Modify: `tests/helpers/sqlite-db.js`
- Modify: `src/progress-api.js`
- Modify: `src/articles-api.js`
- Test: `tests/progress-api.test.js`
- Test: `tests/articles-api.test.js`
- Test: `tests/articles-api-state.test.js`

**Interfaces:**
- Consumes: progress PATCH body fields `lastAloudSentenceIndex?: number | null` and `lastAloudOffsetSeconds?: number`.
- Produces: article progress JSON field `last_aloud_offset_seconds: number`; D1 column `article_progress.last_aloud_offset_seconds REAL NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write failing migration and API tests**

Add the migration to `tests/helpers/sqlite-db.js`, then add tests with these exact expectations:

```js
test('PATCH stores aloud sentence and offset as one snapshot', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  const response = await handleProgressApi(
    jsonRequest('PATCH', {
      lastPositionRatio: 0.2,
      lastAloudSentenceIndex: 4,
      lastAloudOffsetSeconds: 3.25
    }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(DB.get(`
    SELECT last_aloud_sentence_index, last_aloud_offset_seconds
    FROM article_progress WHERE article_id = 'a1'
  `), {
    last_aloud_sentence_index: 4,
    last_aloud_offset_seconds: 3.25
  });
});

test('PATCH rejects an offset without a sentence and clears offset with the sentence', async t => {
  const DB = createSeededDb();
  t.after(() => DB.close());
  insertArticle(DB, 'a1', 'u1', 10, true);
  const invalid = await handleProgressApi(
    jsonRequest('PATCH', {
      lastPositionRatio: 0.2,
      lastAloudOffsetSeconds: 2
    }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );
  assert.equal(invalid.status, 400);
  const cleared = await handleProgressApi(
    jsonRequest('PATCH', {
      lastPositionRatio: 0.2,
      lastAloudSentenceIndex: null,
      lastAloudOffsetSeconds: 0
    }),
    { DB }, '/api/articles/a1/progress', 'u1'
  );
  assert.equal(cleared.status, 200);
});
```

In the article detail/summary response tests, add:

```js
assert.equal(result.progress.last_aloud_sentence_index, 3);
assert.equal(result.progress.last_aloud_offset_seconds, 2.75);
```

In both body-edit and explicit-reset tests, query and assert:

```js
assert.deepEqual(DB.get(`
  SELECT last_aloud_sentence_index, last_aloud_offset_seconds
  FROM article_progress WHERE article_id = 'a1'
`), {
  last_aloud_sentence_index: null,
  last_aloud_offset_seconds: 0
});
```

- [ ] **Step 2: Run the focused API tests and verify failure**

Run:

```powershell
node --test tests/progress-api.test.js tests/articles-api.test.js tests/articles-api-state.test.js
```

Expected: FAIL because migration `0008` and `last_aloud_offset_seconds` do not exist.

- [ ] **Step 3: Add the migration and API implementation**

Create the migration:

```sql
ALTER TABLE article_progress
ADD COLUMN last_aloud_offset_seconds REAL NOT NULL DEFAULT 0
CHECK (last_aloud_offset_seconds >= 0);
```

In `src/progress-api.js`, enforce the atomic rules:

```js
const hasAloudIndex = Object.prototype.hasOwnProperty.call(
  body, 'lastAloudSentenceIndex'
);
const hasAloudOffset = Object.prototype.hasOwnProperty.call(
  body, 'lastAloudOffsetSeconds'
);
const validOffset = !hasAloudOffset || (
  typeof body.lastAloudOffsetSeconds === 'number' &&
  Number.isFinite(body.lastAloudOffsetSeconds) &&
  body.lastAloudOffsetSeconds >= 0
);
if (
  hasAloudOffset && !hasAloudIndex ||
  !validOffset ||
  hasAloudIndex && body.lastAloudSentenceIndex === null &&
    hasAloudOffset && body.lastAloudOffsetSeconds !== 0
) {
  return invalidProgressBody();
}
const aloudOffset = hasAloudIndex && body.lastAloudSentenceIndex !== null
  ? (hasAloudOffset ? body.lastAloudOffsetSeconds : 0)
  : 0;
```

Update the progress UPSERT so `last_aloud_sentence_index` and `last_aloud_offset_seconds` are changed under the same `hasAloudIndex` condition. Keep index-only old clients compatible by storing offset `0`.

In `src/articles-api.js`, select and map the new column:

```js
progress: {
  last_position_ratio: row.last_position_ratio,
  completed: row.completed,
  read_count: row.read_count,
  active_read_ms: row.active_read_ms,
  full_read_aloud_count: row.full_read_aloud_count,
  last_aloud_sentence_index: row.last_aloud_sentence_index ?? null,
  last_aloud_offset_seconds: Number(row.last_aloud_offset_seconds || 0),
  updated_at: row.progress_updated_at
}
```

Set the offset to `0` whenever article body changes or progress is reset.

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```powershell
node --test tests/progress-api.test.js tests/articles-api.test.js tests/articles-api-state.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add migrations/0008_add_article_aloud_offset.sql tests/helpers/sqlite-db.js src/progress-api.js src/articles-api.js tests/progress-api.test.js tests/articles-api.test.js tests/articles-api-state.test.js
git commit -m "feat: persist read-aloud sentence offsets"
```

---

### Task 2: Add local aloud checkpoints and atomic queue payloads

**Files:**
- Create: `public/lib/aloud-checkpoint.js`
- Create: `tests/aloud-checkpoint.test.js`
- Modify: `public/lib/reading-session.js`
- Modify: `tests/reading-session.test.js`

**Interfaces:**
- Produces: `bodyFingerprint(body: string): string`.
- Produces: `createAloudCheckpointStore({ storage, username, now })` with `load({ articleId, body })`, `save({ articleId, body, sentenceIndex, offsetSeconds, state })`, and `clear(articleId)`.
- Extends progress queue positions with `lastAloudOffsetSeconds: number`.

- [ ] **Step 1: Write failing checkpoint tests**

Create `tests/aloud-checkpoint.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyFingerprint,
  createAloudCheckpointStore
} from '../public/lib/aloud-checkpoint.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

test('checkpoint restores only the same user article and body', () => {
  const storage = memoryStorage();
  const store = createAloudCheckpointStore({
    storage, username: 'alice', now: () => 99
  });
  store.save({
    articleId: 'a1', body: 'One. Two.', sentenceIndex: 1,
    offsetSeconds: 2.5, state: 'paused'
  });
  assert.deepEqual(store.load({ articleId: 'a1', body: 'One. Two.' }), {
    articleId: 'a1',
    bodyFingerprint: bodyFingerprint('One. Two.'),
    sentenceIndex: 1,
    offsetSeconds: 2.5,
    state: 'paused',
    savedAt: 99
  });
  assert.equal(store.load({ articleId: 'a1', body: 'Changed.' }), null);
});

test('checkpoint rejects invalid data and tolerates disabled storage', () => {
  const store = createAloudCheckpointStore({
    storage: {
      getItem() { throw new Error('disabled'); },
      setItem() { throw new Error('disabled'); },
      removeItem() { throw new Error('disabled'); }
    },
    username: 'alice'
  });
  assert.equal(store.save({
    articleId: 'a1', body: 'Body.', sentenceIndex: -1,
    offsetSeconds: 0, state: 'paused'
  }), false);
  assert.equal(store.load({ articleId: 'a1', body: 'Body.' }), null);
  assert.equal(store.clear('a1'), false);
});
```

Add a reading-session test asserting `sendProgressItem` includes both aloud fields and queue compaction retains the newest pair.

- [ ] **Step 2: Run tests and verify failure**

```powershell
node --test tests/aloud-checkpoint.test.js tests/reading-session.test.js
```

Expected: FAIL because `aloud-checkpoint.js` does not exist and offset is not sent.

- [ ] **Step 3: Implement the checkpoint module**

Create `public/lib/aloud-checkpoint.js` with these contracts:

```js
const PREFIX = 'pc-aloud-checkpoint';

export function bodyFingerprint(body) {
  const text = String(body ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createAloudCheckpointStore({
  storage, username, now = () => Date.now()
} = {}) {
  const keyFor = articleId =>
    `${PREFIX}:${encodeURIComponent(String(username))}:${encodeURIComponent(String(articleId))}`;
  return {
    load({ articleId, body }) {
      try {
        const value = JSON.parse(storage?.getItem(keyFor(articleId)) || 'null');
        if (
          !value ||
          value.articleId !== String(articleId) ||
          value.bodyFingerprint !== bodyFingerprint(body) ||
          !Number.isInteger(value.sentenceIndex) ||
          value.sentenceIndex < 0 ||
          !Number.isFinite(value.offsetSeconds) ||
          value.offsetSeconds < 0
        ) return null;
        return { ...value };
      } catch {
        return null;
      }
    },
    save({ articleId, body, sentenceIndex, offsetSeconds, state }) {
      if (
        !articleId ||
        !Number.isInteger(sentenceIndex) ||
        sentenceIndex < 0 ||
        !Number.isFinite(offsetSeconds) ||
        offsetSeconds < 0
      ) return false;
      try {
        storage?.setItem(keyFor(articleId), JSON.stringify({
          articleId: String(articleId),
          bodyFingerprint: bodyFingerprint(body),
          sentenceIndex,
          offsetSeconds,
          state: state === 'speaking' ? 'speaking' : 'paused',
          savedAt: now()
        }));
        return true;
      } catch {
        return false;
      }
    },
    clear(articleId) {
      try {
        storage?.removeItem(keyFor(articleId));
        return true;
      } catch {
        return false;
      }
    }
  };
}
```

Extend `sendProgressItem`:

```js
if (Object.prototype.hasOwnProperty.call(item, 'lastAloudSentenceIndex')) {
  body.lastAloudSentenceIndex = item.lastAloudSentenceIndex;
  body.lastAloudOffsetSeconds = item.lastAloudSentenceIndex === null
    ? 0
    : Math.max(0, Number(item.lastAloudOffsetSeconds || 0));
}
```

- [ ] **Step 4: Run tests and verify pass**

```powershell
node --test tests/aloud-checkpoint.test.js tests/reading-session.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/lib/aloud-checkpoint.js public/lib/reading-session.js tests/aloud-checkpoint.test.js tests/reading-session.test.js
git commit -m "feat: store local read-aloud checkpoints"
```

---

### Task 3: Build the persistent wall-clock sleep timer

**Files:**
- Create: `public/lib/sleep-timer.js`
- Create: `tests/sleep-timer.test.js`

**Interfaces:**
- Produces: `createSleepTimer({ storage, key, now, setInterval, clearInterval, tickMs })`.
- Methods: `subscribe(listener)`, `setMinutes(minutes)`, `cancel()`, `check()`, `snapshot()`, and `cleanup()`.
- Snapshot: `{ active: boolean, deadline: number | null, remainingMs: number, expired: boolean }`.

- [ ] **Step 1: Write failing timer tests**

Create tests using a fake clock:

```js
test('sleep timer uses an absolute deadline and expires once', () => {
  let now = 1_000;
  const storage = memoryStorage();
  const timer = createSleepTimer({
    storage, key: 'timer:alice:a1', now: () => now,
    setInterval: () => 1, clearInterval() {}
  });
  const events = [];
  timer.subscribe(state => events.push(state));
  assert.equal(timer.setMinutes(10), true);
  now = 601_000;
  assert.equal(timer.check().expired, true);
  assert.equal(timer.check().expired, false);
  assert.deepEqual(timer.snapshot(), {
    active: false, deadline: null, remainingMs: 0, expired: false
  });
  assert.equal(storage.getItem('timer:alice:a1'), null);
});

test('sleep timer restores a future deadline and rejects invalid minutes', () => {
  let now = 5_000;
  const storage = memoryStorage({
    'timer:alice:a1': JSON.stringify({ deadline: 65_000 })
  });
  const timer = createSleepTimer({
    storage, key: 'timer:alice:a1', now: () => now,
    setInterval: () => 1, clearInterval() {}
  });
  assert.equal(timer.snapshot().remainingMs, 60_000);
  assert.equal(timer.setMinutes(0), false);
  assert.equal(timer.setMinutes(1.5), false);
});
```

- [ ] **Step 2: Run the test and verify failure**

```powershell
node --test tests/sleep-timer.test.js
```

Expected: FAIL because `sleep-timer.js` does not exist.

- [ ] **Step 3: Implement the timer**

Implement an absolute deadline, one-shot `expired: true` result, safe storage access, and one visible tick interval. `check()` must clear expired storage before notifying subscribers:

```js
function makeSnapshot(deadline, now, expired = false) {
  const remainingMs = deadline == null ? 0 : Math.max(0, deadline - now);
  return {
    active: deadline != null && remainingMs > 0,
    deadline: remainingMs > 0 ? deadline : null,
    remainingMs,
    expired
  };
}
```

`setMinutes` accepts only positive integers, stores `{ deadline }`, starts the ticker, and publishes. `cancel` clears storage and publishes an inactive snapshot. `cleanup` stops only the interval; it must not delete a future deadline so page reload can restore it.

- [ ] **Step 4: Run the test and verify pass**

```powershell
node --test tests/sleep-timer.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/lib/sleep-timer.js tests/sleep-timer.test.js
git commit -m "feat: add read-aloud sleep timer"
```

---

### Task 4: Refactor TTS playback around one media element

**Files:**
- Modify: `public/lib/tts-player.js`
- Test: `tests/tts-player.test.js`

**Interfaces:**
- Extends `createTtsPlayer` with `subscribe(listener)`, `getSnapshot()`, `previousSentence()`, `replayCurrentSentence()`, and `nextSentence()`.
- Extends `startArticle(articleId, sentences, startIndex, { offsetSeconds })`.
- Snapshot fields: `state`, `mode`, `articleId`, `currentIndex`, `pendingIndex`, `currentTime`, `duration`, `rate`, `completion`, `completionEvent`, and `fallbackActive`.

- [ ] **Step 1: Replace current fake-audio tests with a reusable controllable audio**

Add a fake that exposes manual `play`, `timeupdate`, and `ended` transitions, then assert one construction and audible-index rules:

```js
class ControlledAudio {
  constructor() {
    this.currentTime = 0;
    this.duration = 0;
    this.playbackRate = 1;
    this.sourceWaiters = [];
  }
  set src(value) {
    this.source = value;
    for (const resolve of this.sourceWaiters.splice(0)) resolve();
  }
  get src() { return this.source; }
  play() {
    this.playCalls = (this.playCalls || 0) + 1;
    return Promise.resolve();
  }
  pause() {
    this.pauseCalls = (this.pauseCalls || 0) + 1;
  }
  waitForSource() {
    if (this.source) return Promise.resolve();
    return new Promise(resolve => this.sourceWaiters.push(resolve));
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
  async finish() {
    this.onended?.();
    await Promise.resolve();
  }
}

test('article playback reuses one audio and changes current only on play', async () => {
  const audio = new ControlledAudio();
  let constructions = 0;
  const states = [];
  const player = createTtsPlayer({
    fetch: async () => new Response(new Uint8Array([1]), { status: 200 }),
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
  await audio.waitForSource();
  assert.equal(states.at(-1).currentIndex, 0);
  await audio.begin();
  assert.equal(states.at(-1).currentIndex, 1);
  await audio.finish();
  await playback;
  assert.equal(constructions, 1);
});
```

Create separate named tests using the same `ControlledAudio` harness and these exact terminal assertions:

```js
assert.equal(player.replayCurrentSentence(), true);
assert.match(paths.at(-1), /\/sentences\/1$/);

assert.equal(player.previousSentence(), true);
assert.match(paths.at(-1), /\/sentences\/0$/);

await audio.finish();
assert.equal(player.replayCurrentSentence(), true);
assert.match(paths.at(-1), /\/sentences\/0$/);
assert.equal(audio.playCalls, 2);

assert.equal(firstSentencePlayer.previousSentence(), false);

await offsetAudio.metadata({ duration: 8 });
assert.equal(offsetAudio.currentTime, 2.5);

player.pause();
const pausedAt = audio.currentTime;
player.resume();
assert.equal(audio.currentTime, pausedAt);

assert.equal(constructionsAfterPointAndArticle, 1);
assert.equal(player.getSnapshot().fallbackActive, true);
```

- [ ] **Step 2: Run the player tests and verify failure**

```powershell
node --test tests/tts-player.test.js
```

Expected: FAIL because the current code constructs an `Audio` per sentence and has no replay methods.

- [ ] **Step 3: Implement the single-element state machine**

Create the media element once:

```js
const audio = AudioClass ? new AudioClass() : null;
const subscribers = new Set();
let articleSession = null;
let state = 'idle';
let mode = 'idle';
let articleId = null;
let currentIndex = null;
let pendingIndex = null;
let completion = emptyCompletion();
```

Only the media element's actual `play` event may perform:

```js
currentIndex = pendingIndex;
pendingIndex = null;
state = 'speaking';
publish();
```

Keep `articleSession` as:

```js
{
  texts,
  articleId,
  startIndex,
  completed: new Set(),
  token
}
```

Implement a serialized `playArticleIndex(index, { offsetSeconds = 0 })` that:

1. increments a generation token;
2. aborts the pending fetch and revokes the previous Blob URL;
3. leaves `currentIndex` unchanged while fetching and buffering;
4. assigns `pendingIndex = index`;
5. waits for metadata before clamping and applying `audio.currentTime`;
6. calls `audio.play()` from the existing user-initiated operation;
7. on `ended`, adds the audible index to `completed` and advances.

Implement replay targets:

```js
previousSentence() {
  if (!articleSession || !Number.isInteger(currentIndex) || currentIndex === 0) {
    return false;
  }
  void playArticleIndex(currentIndex - 1);
  return true;
},
replayCurrentSentence() {
  if (!articleSession || !Number.isInteger(currentIndex)) return false;
  void playArticleIndex(currentIndex);
  return true;
},
nextSentence() {
  if (
    !articleSession ||
    !Number.isInteger(currentIndex) ||
    currentIndex >= articleSession.texts.length - 1
  ) return false;
  void playArticleIndex(currentIndex + 1);
  return true;
}
```

Publish `timeupdate`, `durationchange`, pause, resume, fallback, and completion changes. Preserve the existing completion rule: only a natural end from start index `0` publishes the counted completion event.

- [ ] **Step 4: Run player tests and verify pass**

```powershell
node --test tests/tts-player.test.js
```

Expected: all tests PASS, including existing fallback and completion tests.

- [ ] **Step 5: Commit**

```powershell
git add public/lib/tts-player.js tests/tts-player.test.js
git commit -m "feat: reuse media element for article playback"
```

---

### Task 5: Add Media Session action mapping

**Files:**
- Create: `public/lib/media-session.js`
- Create: `tests/media-session.test.js`

**Interfaces:**
- Produces: `createMediaSessionBridge({ mediaSession, MediaMetadata })`.
- Methods: `bind({ play, pause, previous, current, next })`, `update({ state, currentIndex, sentenceCount, title, author, sentence })`, and `cleanup()`.

- [ ] **Step 1: Write failing Media Session tests**

```js
test('media session maps previous current and next independently', () => {
  const actions = new Map();
  const calls = [];
  const mediaSession = {
    setActionHandler(name, handler) { actions.set(name, handler); },
    metadata: null,
    playbackState: 'none'
  };
  const bridge = createMediaSessionBridge({
    mediaSession,
    MediaMetadata: class { constructor(value) { Object.assign(this, value); } }
  });
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
});
```

Add tests that first sentence clears `previoustrack`, last sentence clears `nexttrack`, one unsupported action does not block others, and cleanup clears every registered action and metadata.

- [ ] **Step 2: Run the test and verify failure**

```powershell
node --test tests/media-session.test.js
```

Expected: FAIL because `media-session.js` does not exist.

- [ ] **Step 3: Implement the feature-detected bridge**

Use a guarded helper:

```js
function setAction(mediaSession, name, handler) {
  try {
    mediaSession?.setActionHandler?.(name, handler);
    return true;
  } catch {
    return false;
  }
}
```

Map `play`, `pause`, `previoustrack`, `seekbackward`, and `nexttrack`. In `update`, set `previoustrack` to `null` for index `0`, set `nexttrack` to `null` for the last index, set playback state to `playing`, `paused`, or `none`, and create metadata only when `MediaMetadata` is supported.

- [ ] **Step 4: Run the test and verify pass**

```powershell
node --test tests/media-session.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/lib/media-session.js tests/media-session.test.js
git commit -m "feat: expose article media session controls"
```

---

### Task 6: Integrate recovery, timer, and lifecycle into the reader

**Files:**
- Modify: `public/app.js`
- Modify: `public/articles-view.js`
- Modify: `public/reader-view.js`
- Test: `tests/reader-pending-dom.test.js`
- Test: `tests/ui-dom.test.js`

**Interfaces:**
- `createReaderView` additionally consumes `username`, `storage`, and `mediaRuntime`.
- `mediaRuntime` provides `mediaSession`, `MediaMetadata`, `now`, timer functions, and page lifecycle constructors for deterministic tests.
- `createArticlesView` additionally consumes `aloudCheckpointStore` and clears it after a body edit or explicit progress reset.

- [ ] **Step 1: Write failing reader recovery and lifecycle tests**

Add DOM tests for these concrete flows:

```js
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
  await env.ready();
  assert.match(
    env.root.querySelector('[data-role="aloud-resume-entry"]').textContent,
    /第 2 句/
  );
  click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
  assert.deepEqual(env.tts.starts.at(-1), {
    articleId: 'a1', startIndex: 1, offsetSeconds: 2.5
  });
});

test('expired timer pauses and checkpoints on pageshow', async () => {
  const env = setupReader({ timerDeadline: 100, now: 200 });
  await env.ready();
  env.window.dispatchEvent(new env.window.Event('pageshow'));
  assert.equal(env.tts.pauseCalls, 1);
  assert.match(
    env.root.querySelector('[data-role="speech-status"]').textContent,
    /定时结束/
  );
});
```

Create the remaining named tests with these exact observable outcomes:

```js
assert.equal(resumeState.source, 'live');
assert.deepEqual(resumeState.position, { sentenceIndex: 2, offsetSeconds: 1.5 });

assert.equal(fingerprintMismatchResume.source, 'server');
assert.deepEqual(fingerprintMismatchResume.position, {
  sentenceIndex: 1, offsetSeconds: 0.75
});

assert.equal(checkpointSavesAfterStart, 1);
assert.equal(checkpointSavesWithinTwoSeconds, 1);
assert.equal(checkpointSavesAfterPause, 2);

env.window.dispatchEvent(new env.window.Event('pagehide'));
assert.deepEqual(checkpointStore.lastSaved, {
  sentenceIndex: 2, offsetSeconds: 4.25, state: 'paused'
});

assert.deepEqual(progressQueue.snapshot().at(-1), {
  kind: 'position',
  articleId: 'a1',
  lastPositionRatio: 0,
  lastAloudSentenceIndex: 2,
  lastAloudOffsetSeconds: 4.25
});

assert.equal(checkpointStore.clearedArticleId, 'a1');
assert.deepEqual(progressQueue.snapshot().at(-1), {
  kind: 'position',
  articleId: 'a1',
  lastPositionRatio: 0,
  lastAloudSentenceIndex: null,
  lastAloudOffsetSeconds: 0
});

assert.match(
  env.root.querySelector('[data-role="speech-fallback-warning"]').textContent,
  /锁屏后台播放可能受限/
);

assert.equal(mediaSession.handlers.size, 0);
assert.notEqual(storage.getItem(timerKey), null);
```

- [ ] **Step 2: Run reader tests and verify failure**

```powershell
node --test tests/reader-pending-dom.test.js tests/ui-dom.test.js
```

Expected: FAIL because the reader lacks checkpoint/timer/media wiring.

- [ ] **Step 3: Wire application-scoped dependencies**

In `public/app.js`, create the user-scoped store after login:

```js
aloudCheckpointStore = createAloudCheckpointStore({
  storage: progressStorage,
  username: currentUsername
});
```

Pass `username`, `storage`, and:

```js
mediaRuntime: {
  mediaSession: navigator.mediaSession,
  MediaMetadata: globalThis.MediaMetadata
}
```

to `createReaderView`. Pass `aloudCheckpointStore` to `createArticlesView`. Clear the store for an article only after a successful body-changing edit or explicit reset.

- [ ] **Step 4: Make the TTS snapshot authoritative in `reader-view.js`**

Subscribe to `tts || speech`, not always to `speech`. Track:

```js
let activeAloudSentenceIndex = null;
let activeAloudOffsetSeconds = 0;
let savedAloudSentenceIndex = null;
let savedAloudOffsetSeconds = 0;
let lastLocalCheckpointAt = 0;
```

Resolve resume state in this order:

```js
const live = tts?.getSnapshot?.();
const local = aloudCheckpointStore?.load({ articleId, body: article.body });
const serverIndex = article.progress?.last_aloud_sentence_index;
const serverOffset = Number(article.progress?.last_aloud_offset_seconds || 0);
```

Use live state only when `live.articleId === articleId` and it has a valid current index; otherwise use local, then server.

Change `startFullReading` to:

```js
function startFullReading(index, offsetSeconds = 0) {
  setStartSelectionMode(false);
  if (tts?.startArticle) {
    tts.startArticle(
      articleId,
      sentences.map(sentence => sentence.text),
      index,
      { offsetSeconds }
    );
  } else {
    speech.startAt(index);
  }
}
```

On valid player snapshots, save the local checkpoint immediately for state changes and at most once every two seconds for time updates. Queue D1 snapshots with both aloud fields. On completion/restart clear local state and queue `{ lastAloudSentenceIndex: null, lastAloudOffsetSeconds: 0 }`.

- [ ] **Step 5: Integrate timer and Media Session lifecycle**

Create a timer key scoped to user and article:

```js
const sleepTimer = createSleepTimer({
  storage,
  key: `pc-aloud-timer:${encodeURIComponent(username)}:${encodeURIComponent(articleId)}`,
  now: runtime.now,
  setInterval: runtime.setInterval,
  clearInterval: runtime.clearInterval
});
```

Call `sleepTimer.check()` from player state updates, `visibilitychange`, `pageshow`, and before playback actions. When `{ expired: true }`, call `(tts || speech).pause()`, save the checkpoint, and announce `定时结束，已暂停`.

Also subscribe so the timer's own interval can pause playback while the page remains eligible for background media events:

```js
unsubscribeTimer = sleepTimer.subscribe(timerState => {
  if (!timerState.expired) {
    syncTimerControls(timerState);
    return;
  }
  (tts || speech).pause();
  saveAloudCheckpoint({ immediate: true });
  announceSpeechStatus('定时结束，已暂停');
  syncTimerControls(timerState);
});
```

Bind Media Session controls:

```js
mediaBridge.bind({
  play: () => (tts || speech).resume(),
  pause: () => (tts || speech).pause(),
  previous: () => tts?.previousSentence?.(),
  current: () => tts?.replayCurrentSentence?.(),
  next: () => tts?.nextSentence?.()
});
```

Update metadata from the actual audible index. On cleanup, remove page listeners, clean the bridge, stop the timer ticker without clearing a future deadline, save the final checkpoint, and stop playback only for an actual SPA route change.

- [ ] **Step 6: Run reader tests and verify pass**

```powershell
node --test tests/reader-pending-dom.test.js tests/ui-dom.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add public/app.js public/articles-view.js public/reader-view.js tests/reader-pending-dom.test.js tests/ui-dom.test.js
git commit -m "feat: restore mobile read-aloud sessions"
```

---

### Task 7: Add previous/current controls and timer UI

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Test: `tests/reader-pending-dom.test.js`
- Test: `tests/static-shell.test.js`

**Interfaces:**
- Adds actions `speech-previous`, `speech-current`, `speech-timer`, `speech-timer-set`, `speech-timer-cancel`, plus equivalent floating actions.
- Adds roles `sleep-timer-panel`, `sleep-timer-remaining`, and `speech-fallback-warning`.

- [ ] **Step 1: Write failing DOM and CSS tests**

Assert:

```js
assert.equal(
  env.root.querySelector('[data-action="speech-previous"]').disabled,
  true
);
assert.equal(
  env.root.querySelector('[data-action="speech-current"]').disabled,
  false
);
assert.deepEqual(
  [...env.root.querySelectorAll('[data-role="floating-speech"] [data-action]')]
    .map(node => node.dataset.action),
  [
    'speech-floating-previous',
    'speech-floating-current',
    'speech-floating-toggle',
    'speech-floating-timer'
  ]
);
```

Add interactions for previous/current target selection, timer presets, custom validation, replacing/canceling a timer, `mm:ss` output, Escape close/focus return, and expired status.

In `tests/static-shell.test.js`, assert `.pc-floating-speech-action` has `min-height: 44px`, the capsule uses four flexible columns, and the `max-width: 380px` rules reduce horizontal padding without hiding labels or overflowing.

- [ ] **Step 2: Run DOM/static tests and verify failure**

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: FAIL because the actions and styles do not exist.

- [ ] **Step 3: Render and handle the controls**

Top toolbar order:

```js
toolbar.append(primary, previous, current, timerButton, restart, rateLabel);
```

Floating order:

```js
capsule.append(
  floatingPrevious,
  divider(),
  floatingCurrent,
  divider(),
  floatingToggle,
  divider(),
  floatingTimer
);
```

Disable previous at index `0`, disable both replay buttons without an audible sentence, and call the TTS replay methods directly. Timer panel presets carry `data-minutes="10"`, `20`, `30`, and `60`; custom input uses `type="number"`, `min="1"`, `step="1"`, and an associated live error node.

Format remaining time:

```js
function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
```

The panel closes on successful set, cancel, Escape, outside click, and unmount; focus returns to the opening timer button.

- [ ] **Step 4: Add responsive styles**

Use:

```css
.pc-floating-speech {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, auto));
  max-width: calc(100vw - 24px);
}

.pc-floating-speech-action {
  min-width: 0;
  min-height: 44px;
  padding-inline: 10px;
  white-space: nowrap;
}

@media (max-width: 380px) {
  .pc-floating-speech-action {
    padding-inline: 7px;
    font-size: 13px;
  }
}
```

Style the timer panel as an anchored desktop popover and the existing safe-area-aware bottom sheet on phone/coarse-pointer breakpoints. Preserve focus-visible outlines and dark/light variables.

- [ ] **Step 5: Run DOM/static tests and verify pass**

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "feat: add mobile aloud replay and timer controls"
```

---

### Task 8: Document, regress, and prepare real-device acceptance

**Files:**
- Modify: `README.md`
- Verify: all source, migration, and test files changed in Tasks 1–7

**Interfaces:**
- Consumes all prior task deliverables.
- Produces the final automated verification record and user-facing manual checklist.

- [ ] **Step 1: Update README behavior and limits**

Document these exact rules:

- the player reuses one HTML media element for better lock-screen continuity;
- the local checkpoint restores sentence and in-sentence offset, with D1 as cross-device fallback;
- previous/current replay are distinct and continue forward;
- timer presets are 10/20/30/60 plus custom minutes and pause immediately at deadline;
- Web Speech fallback may not continue under lock screen;
- OS suspension can delay timer enforcement until the next media/page event;
- real iPhone Safari and Android Chrome verification is required.

- [ ] **Step 2: Run syntax and focused feature tests**

```powershell
node --check public/lib/aloud-checkpoint.js
node --check public/lib/sleep-timer.js
node --check public/lib/media-session.js
node --check public/lib/tts-player.js
node --check public/reader-view.js
node --test tests/aloud-checkpoint.test.js tests/sleep-timer.test.js tests/media-session.test.js tests/tts-player.test.js tests/reading-session.test.js tests/progress-api.test.js tests/articles-api.test.js tests/articles-api-state.test.js tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: every syntax check exits `0`; every focused test passes.

- [ ] **Step 3: Run the complete regression suite**

```powershell
npm test
npm run test:all
git diff --check
```

Expected: both suites PASS and `git diff --check` prints nothing.

- [ ] **Step 4: Inspect the responsive UI in automated browser widths**

Run the local Worker and inspect authenticated reader pages at:

- `320x720`;
- `375x812`;
- `844x390`;
- desktop width.

Verify the four-control capsule stays on one row without horizontal overflow; timer bottom sheet respects `safe-area-inset-bottom`; current sentence remains visible; focus and Escape work; dark and light themes remain legible.

- [ ] **Step 5: Commit documentation and final automated fixes**

```powershell
git add README.md
git commit -m "docs: explain mobile read-aloud controls"
```

- [ ] **Step 6: Hand off the real-device acceptance checklist**

Ask the user to verify on both iPhone Safari and Android Chrome:

1. lock the phone during a multi-sentence article and hear several sentence boundaries;
2. use available lock-screen play/pause/previous/current/next controls;
3. unlock without losing audible sentence or offset;
4. reload or allow OS page eviction, then use “继续” at the saved offset;
5. expire a short timer mid-sentence while visible and while locked;
6. after the next sentence begins, confirm “上一句” replays the just-finished sentence while “本句” replays the audible sentence;
7. exercise the four mobile controls without selection conflicts or overflow;
8. force cloud TTS failure and verify the Web Speech limitation notice.

Do not mark the feature complete until automated verification is green and the user reports both real-device checks.
