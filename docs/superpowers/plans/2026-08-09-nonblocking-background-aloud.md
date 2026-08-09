# Nonblocking Background Aloud Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start or resume article speech through the existing sentence player immediately while native HLS prepares in parallel and takes over only at a safe sentence boundary.

**Architecture:** Keep the article session and its completion set as the single source of truth. Split HLS preparation from HLS media activation: preparation stores a validated timeline and playlist on the live session without changing the audible state; the sentence `onended` path activates the prepared HLS at the next sentence only when play intent is true. Reader controls reflect the audible/pending foreground state and remain visible during a short media-source handoff.

**Tech Stack:** Browser JavaScript ES modules, HTMLMediaElement, Node.js built-in test runner, JSDOM.

## Global Constraints

- Ordinary sentence playback must begin without waiting for HLS preparation.
- HLS preparation is optional enhancement work and must not change normal playback progress.
- The floating controls remain available; pause/continue, previous sentence, and replay target the actual audible sentence.
- Only actually completed sentences count toward coverage and completion.
- No server API or persistence schema changes.

---

### Task 1: Separate HLS preparation from foreground playback

**Files:**
- Modify: `tests/tts-player.test.js`
- Modify: `public/lib/tts-player.js`

**Interfaces:**
- Consumes: existing `startArticle(articleId, texts, startIndex, options)`, `playArticleIndex(index, options)`, HLS prepare endpoint response, and article-session `completed`/`playIntent` state.
- Produces: private `prepareHlsArticle(session)` storing `session.preparedHls`; private `playPreparedHls(session, index, options)` activating an already validated playlist; `startArticle` starts both sentence playback and background preparation.

- [ ] **Step 1: Write failing tests for nonblocking startup and boundary takeover**

Add tests using a deferred HLS response and the existing `ControlledAudio`:

```js
test('native HLS preparation does not block the first sentence and takes over at the next boundary', async () => {
  const prepared = deferred();
  const audio = hlsAudio();
  const paths = [];
  const player = createTtsPlayer({
    fetch: async path => {
      paths.push(path);
      if (path.includes('/hls/prepare')) return prepared.promise;
      return cloudResponse();
    },
    Audio: class { constructor() { return audio; } },
    URL: fakeUrlApi(), fallback: fakeFallback()
  });

  void player.startArticle('a1', ['One.', 'Two.'], 0);
  await audio.waitForSource();
  assert.match(audio.src, /^blob:test-/);
  await audio.begin();
  assert.equal(player.getSnapshot().state, 'speaking');

  prepared.resolve(hlsTimelineResponse(2));
  await flush();
  assert.match(audio.src, /^blob:test-/);
  await audio.finish();
  await audio.waitForSource(2);
  assert.equal(audio.src, '/stream.m3u8');
});
```

Also assert the first sentence completion is retained after HLS metadata/play and that the HLS position begins at sentence index 1.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="does not block the first sentence" tests/tts-player.test.js`

Expected: FAIL because current `startArticle` waits for HLS preparation before assigning a sentence object URL.

- [ ] **Step 3: Implement cancellable background preparation**

In `public/lib/tts-player.js`, move the prepare-loop and response normalization out of `playHlsArticle`:

```js
async function prepareHlsArticle(session) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  session.hlsPrepareController = controller;
  // Follow bounded cursors, validate the live session after every await,
  // normalize the timeline, then assign session.preparedHls.
  // Do not assign audio.src, state, pendingIndex, currentIndex, or backgroundMode.
}
```

Abort `session.hlsPrepareController` from `abandonArticleSession`. A failed or stale preparation returns `false` without invoking `playArticleIndex` or publishing a playback state.

- [ ] **Step 4: Start sentence playback immediately and prepare HLS in parallel**

Change `startArticle` to:

```js
void playArticleIndex(nextIndex, { offsetSeconds: options.offsetSeconds });
if (session.preferHls) void prepareHlsArticle(session);
```

Change HLS activation to consume `session.preparedHls` without fetching. At sentence `onended`, after adding the completed sentence and before calling the next `playArticleIndex`, activate prepared HLS at `nextIndex` when `session.playIntent` is true; otherwise retain `heldIndex` and remain paused.

- [ ] **Step 5: Run focused and full player tests**

Run: `node --test --test-name-pattern="native HLS" tests/tts-player.test.js`

Expected: PASS after updating existing HLS expectations to the new sentence-first contract.

Run: `node --test tests/tts-player.test.js`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add tests/tts-player.test.js public/lib/tts-player.js
git commit -m "fix: prepare background aloud without blocking speech"
```

### Task 2: Preserve controls, pause intent, and navigation during preparation

**Files:**
- Modify: `tests/tts-player.test.js`
- Modify: `public/lib/tts-player.js`
- Modify: `tests/reader-pending-dom.test.js`
- Modify: `public/reader-view.js`

**Interfaces:**
- Consumes: `pause()`, `resume()`, `previousSentence()`, `replayCurrentSentence()`, TTS snapshots, and reader `syncSpeechControls()`.
- Produces: preparation-safe control behavior and floating-control visibility during foreground loading or HLS handoff.

- [ ] **Step 1: Write failing player control tests**

Add separate tests proving that, while the HLS prepare promise is unresolved, the already-started sentence can be paused/resumed, previous/replay changes the sentence source immediately, and a preparation result that arrives while paused does not activate HLS.

```js
player.pause();
assert.equal(player.getSnapshot().state, 'paused');
prepared.resolve(hlsTimelineResponse(3));
await flush();
assert.match(audio.src, /^blob:test-/);
player.resume();
assert.equal(audio.playCalls, playCallsBeforeResume + 1);
```

- [ ] **Step 2: Run focused control tests and verify RED**

Run: `node --test --test-name-pattern="HLS preparation.*pause|HLS preparation.*replay" tests/tts-player.test.js`

Expected: at least one FAIL because preparation and active media currently share cancellation/state fields.

- [ ] **Step 3: Isolate preparation cancellation from foreground media cancellation**

Keep the HLS preparation controller on `articleSession`, not in `activeController`. `invalidateMedia()` must cancel only the foreground media request. Previous/replay continue to call `playArticleIndex` until `session.hls` is active; prepared HLS remains eligible for a later sentence-boundary takeover.

- [ ] **Step 4: Write failing reader DOM test for floating controls**

Extend the reader fake to emit `{ state: 'loading', mode: 'article', currentIndex: 1, pendingIndex: 2, backgroundMode: 'hls' }` while the toolbar observer reports offscreen. Assert the floating group remains visible, its toggle can call `pause`, and previous/replay remain enabled against the last audible sentence.

- [ ] **Step 5: Run the reader test and verify RED**

Run: `node --test --test-name-pattern="floating controls.*loading" tests/reader-pending-dom.test.js`

Expected: FAIL because `syncSpeechControls()` excludes `loading` from `hasAvailableAction`, and loading is not treated as a pausable article action.

- [ ] **Step 6: Implement minimal reader control behavior**

In `speechAction`, treat article `loading` with a known current or pending reading position as a pause-capable action. Include `loading` in floating visibility when a full-reading position exists. In both primary click handlers, call `audioController.pause()` for this pausable loading state. Preserve `activeAloudSentenceIndex` during handoff so previous/replay use the last audible sentence.

- [ ] **Step 7: Run reader and player suites**

Run: `node --test tests/reader-pending-dom.test.js tests/tts-player.test.js`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add tests/tts-player.test.js public/lib/tts-player.js tests/reader-pending-dom.test.js public/reader-view.js
git commit -m "fix: keep aloud controls active during background preparation"
```

### Task 3: Verify progress, fallback, and regressions

**Files:**
- Modify: `tests/tts-player.test.js` only if a missing regression assertion is discovered.

**Interfaces:**
- Consumes: player completion snapshot `{ reachedEnd, coverage, counted }` and all existing test scripts.
- Produces: evidence that background preparation and takeover do not double-count progress or regress non-HLS playback.

- [ ] **Step 1: Add a failing progress handoff regression if Task 1 does not already cover it**

Assert coverage is `1 / 3` after the first sentence ends and remains `1 / 3` immediately after HLS takeover; it becomes `2 / 3` only after media time crosses the second sentence end.

- [ ] **Step 2: Run the progress regression and verify RED when added**

Run: `node --test --test-name-pattern="handoff.*coverage" tests/tts-player.test.js`

Expected: FAIL before the completion-set handoff is corrected, or skip this new test only when the Task 1 test already makes the same assertions.

- [ ] **Step 3: Apply the minimal completion bookkeeping correction**

Seed HLS `eligibleFromStart` from the takeover sentence only. Reuse `session.completed`; never infer completion from prepared timeline duration. Keep `lastGlobalTime` equal to the takeover global time before the first HLS time update.

- [ ] **Step 4: Run complete verification**

Run: `npm test`

Expected: all top-level tests PASS.

Run: `npm run test:all`

Expected: all recursive tests PASS with no unhandled rejection or warning.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Commit any final regression test correction**

```bash
git add tests/tts-player.test.js public/lib/tts-player.js
git commit -m "test: cover background aloud handoff progress"
```
