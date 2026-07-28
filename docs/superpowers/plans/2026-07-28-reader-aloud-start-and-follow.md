# Reader Precise Read-Aloud Start and Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offscreen read-aloud controls context-aware, let users choose an exact sentence when no breakpoint exists, keep the active full-reading sentence visible, and keep the mobile breakpoint row on one line.

**Architecture:** Extend the state already owned by `createReaderView` rather than adding a second controller. The floating capsule derives its label and action from speech state, saved breakpoint state, start-selection mode, toolbar visibility, and bottom-panel visibility. Sentence following consumes existing speech state notifications and performs a bounded viewport check before scrolling.

**Tech Stack:** Browser DOM APIs, IntersectionObserver, Web Speech/Azure TTS controller abstractions, CSS media queries, Node.js test runner, JSDOM.

## Global Constraints

- Preserve Azure TTS priority and browser speech fallback.
- Preserve ordinary sentence-click single-sentence speech outside start-selection mode.
- Do not use long press, double click, or drag for choosing a start sentence.
- Do not change the progress API, database schema, read-aloud counts, or scroll-progress restoration.
- Show the floating capsule only after the top speech toolbar is fully outside the viewport and never over a word/selection panel.
- Use `0.5× → 1× → 1.5×` for the existing rate cycle.
- Use the visible label “跳转”; do not reintroduce “定位” or a second breakpoint “继续朗读” button.
- On narrow screens, keep the breakpoint summary and “跳转” on one line with a minimum `44px` button height.
- Respect `prefers-reduced-motion: reduce`.

---

### Task 1: Unify Breakpoint Resume Actions and Mobile Layout

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Test: `tests/reader-pending-dom.test.js`
- Test: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: existing `savedAloudSentenceIndex`, `speechState`, `locateSentence(index)`, `startFullReading(index)`, and delegated `data-action` click handling.
- Produces: a breakpoint entry with `data-action="speech-jump-resume"` only; contextual top `data-action="speech-resume"` behavior.

- [ ] **Step 1: Write failing DOM tests for one breakpoint action and contextual top resume**

In `tests/reader-pending-dom.test.js`, update the long-reading breakpoint test and add assertions equivalent to:

```js
const entry = env.root.querySelector('[data-role="aloud-resume-entry"]');
assert.equal(entry.querySelector('[data-action="speech-continue-resume"]'), null);
assert.equal(entry.querySelector('[data-action="speech-jump-resume"]').textContent, '跳转');

click(env.window, entry.querySelector('[data-action="speech-jump-resume"]'));
assert.equal(located.block, 'center');
assert.equal(env.window.document.activeElement, resumedSentence);
assert.equal(speech.calls.some(call => call[0] === 'startAt'), false);

click(env.window, env.root.querySelector('[data-action="speech-resume"]'));
assert.deepEqual(speech.calls.at(-1), ['startAt', 1]);
```

Add a separate paused-state assertion:

```js
speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
speech.emit({ state: 'paused', currentIndex: 1, completion: { reachedEnd: false } });
click(env.window, env.root.querySelector('[data-action="speech-resume"]'));
assert.deepEqual(speech.calls.at(-1), ['resume']);
```

- [ ] **Step 2: Write a failing CSS test for the two-column mobile row**

In `tests/static-shell.test.js`, extend the long-reading CSS test:

```js
assert.match(
  css,
  /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-aloud-resume-entry\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/
);
assert.match(
  css,
  /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-aloud-resume-copy\s*\{[^}]*white-space:\s*nowrap[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/
);
assert.match(
  css,
  /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-aloud-resume-entry\s+\.pc-btn-ghost\s*\{[^}]*min-height:\s*44px[^}]*white-space:\s*nowrap/
);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="long reading|long-reading capsule" tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: FAIL because the entry still contains “定位” and `speech-continue-resume`, top resume does not start from an idle breakpoint, and the mobile row is not a two-column ellipsis layout.

- [ ] **Step 4: Implement the unified breakpoint entry**

In `public/reader-view.js`, replace the fixed-length summary and two actions in `resumeEntry()`:

```js
host.append(
  element(
    'span',
    'pc-aloud-resume-copy',
    `上次朗读：第 ${savedAloudSentenceIndex + 1} 句 “${snippet}”`
  ),
  actionButton('speech-jump-resume', '跳转')
);
```

Replace the old click actions with:

```js
if (action === 'speech-jump-resume' && Number.isInteger(savedAloudSentenceIndex)) {
  locateSentence(savedAloudSentenceIndex);
}
if (action === 'speech-resume') {
  if (speechState === 'paused') {
    (tts || speech).resume();
  } else if (speechState === 'idle' && Number.isInteger(savedAloudSentenceIndex)) {
    const index = savedAloudSentenceIndex;
    locateSentence(index);
    startFullReading(index);
  }
}
```

Remove the unconditional old `speech-resume` call and delete the `speech-continue-resume` handler.

- [ ] **Step 5: Implement the narrow-screen row**

In the existing phone/coarse-tablet media query in `public/styles.css`, add:

```css
.pc-aloud-resume-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
}
.pc-aloud-resume-copy {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-aloud-resume-entry .pc-btn-ghost {
  min-height: 44px;
  padding-inline: 10px;
  white-space: nowrap;
}
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="long reading|long-reading capsule" tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "fix: unify read-aloud resume actions"
```

---

### Task 2: Add Exact Start-Sentence Selection

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Test: `tests/reader-pending-dom.test.js`
- Test: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: `speechState`, `savedAloudSentenceIndex`, `speechToolbarOffscreen`, `startFullReading(index)`, sentence `data-sentence-index`, and `syncSpeechControls()`.
- Produces: local boolean `startSelectionMode`; functions `setStartSelectionMode(enabled)` and `floatingSpeechAction()`; root class `pc-reader-start-selecting`; role `reader-start-hint`.

- [ ] **Step 1: Write failing DOM tests for idle capsule states**

Add a test that mounts an article with `last_aloud_sentence_index: null`, captures the injected IntersectionObserver callback, marks the toolbar offscreen, and asserts:

```js
observerCallback([{ isIntersecting: false }]);
const floating = env.root.querySelector('[data-role="floating-speech"]');
const toggle = floating.querySelector('[data-role="floating-speech-toggle"]');
assert.equal(floating.hidden, false);
assert.equal(toggle.textContent, '选择起点');
assert.equal(toggle.getAttribute('aria-label'), '选择全文朗读起点');
```

Extend the saved-breakpoint case:

```js
observerCallback([{ isIntersecting: false }]);
assert.equal(
  env.root.querySelector('[data-role="floating-speech-toggle"]').textContent,
  '继续'
);
click(env.window, env.root.querySelector('[data-role="floating-speech-toggle"]'));
assert.deepEqual(speech.calls.at(-1), ['startAt', 1]);
```

- [ ] **Step 2: Write failing interaction tests for exact sentence choice and cancellation**

In the no-breakpoint test:

```js
click(env.window, toggle);
assert.ok(env.root.classList.contains('pc-reader-start-selecting'));
assert.equal(toggle.textContent, '取消选择');
assert.equal(env.root.querySelector('[data-role="reader-start-hint"]').hidden, false);
assert.equal(speech.calls.some(call => call[0] === 'startAt'), false);

const chosen = env.root.querySelector('[data-sentence-index="2"]');
click(env.window, chosen);
assert.deepEqual(speech.calls.at(-1), ['startAt', 2]);
assert.equal(env.root.classList.contains('pc-reader-start-selecting'), false);
```

Verify a highlighted term chooses its containing sentence instead of opening a panel:

```js
click(env.window, toggle);
const term = env.root.querySelector('[data-sentence-index="2"] .pc-term');
click(env.window, term);
assert.deepEqual(speech.calls.at(-1), ['startAt', 2]);
assert.equal(env.root.querySelector('[data-role="term-popover"]'), null);
```

Verify cancellation and preservation of normal behavior:

```js
click(env.window, toggle);
env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
  key: 'Escape', bubbles: true, cancelable: true
}));
assert.equal(env.root.classList.contains('pc-reader-start-selecting'), false);

click(env.window, env.root.querySelector('[data-sentence-index="0"]'));
assert.equal(speech.calls.at(-1)[0], 'speakOnce');
```

- [ ] **Step 3: Write a failing static style test for selection mode**

In `tests/static-shell.test.js`, assert:

```js
assert.match(css, /\.pc-reader-start-selecting\s+\.pc-reader-sentence\s*\{[^}]*outline/);
assert.match(css, /\.pc-reader-start-selecting\s+\.pc-reader-sentence:focus-visible/);
assert.match(css, /\.pc-reader-start-hint\s*\{[^}]*color:\s*var\(--ink-dim\)/);
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="start sentence|long reading|long-reading capsule" tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: FAIL because idle/no-breakpoint currently hides the capsule and no start-selection mode exists.

- [ ] **Step 5: Implement the state and UI derivation**

In `createReaderView`, add:

```js
let startSelectionMode = false;
```

Add:

```js
function setStartSelectionMode(enabled) {
  startSelectionMode = Boolean(enabled);
  root.classList.toggle('pc-reader-start-selecting', startSelectionMode);
  const hint = root.querySelector('[data-role="reader-start-hint"]');
  if (hint) hint.hidden = !startSelectionMode;
  syncSpeechControls();
}

function floatingSpeechAction() {
  if (speechState === 'speaking') {
    return { label: '暂停', ariaLabel: '暂停全文朗读' };
  }
  if (speechState === 'paused' || Number.isInteger(savedAloudSentenceIndex)) {
    return { label: '继续', ariaLabel: '继续全文朗读' };
  }
  if (startSelectionMode) {
    return { label: '取消选择', ariaLabel: '取消选择全文朗读起点' };
  }
  return { label: '选择起点', ariaLabel: '选择全文朗读起点' };
}
```

Update `syncSpeechControls()` so the floating control is visible when:

```js
const hasAvailableAction =
  speechState === 'speaking' ||
  speechState === 'paused' ||
  speechState === 'idle';

floating.hidden = !(
  speechToolbarOffscreen &&
  hasAvailableAction &&
  !bottomPanelOpen()
);
```

Use `floatingSpeechAction()` for the toggle text and accessible name.

- [ ] **Step 6: Add the hint and exact selection behavior**

In `render()`, create the hint immediately before the reader body:

```js
const startHint = element(
  'div',
  'pc-reader-start-hint',
  '请选择开始全文朗读的句子'
);
startHint.dataset.role = 'reader-start-hint';
startHint.setAttribute('role', 'status');
startHint.hidden = !startSelectionMode;
content.append(startHint);
```

At the start of `onClick`, before normal term actions:

```js
const chosenSentence = event.target.closest?.(
  '[data-role="reader-text"] [data-sentence-index]'
);
if (startSelectionMode && chosenSentence && root.contains(chosenSentence)) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const index = Number(chosenSentence.dataset.sentenceIndex);
  setStartSelectionMode(false);
  if (Number.isInteger(index)) startFullReading(index);
  return;
}
```

Make the floating action contextual:

```js
if (action === 'speech-floating-toggle') {
  if (speechState === 'speaking') {
    (tts || speech).pause();
  } else if (speechState === 'paused') {
    (tts || speech).resume();
  } else if (Number.isInteger(savedAloudSentenceIndex)) {
    startFullReading(savedAloudSentenceIndex);
  } else {
    setStartSelectionMode(!startSelectionMode);
  }
}
```

In `onKeyDown`, handle Enter/Space while selecting before single-sentence speech, and handle Escape before popover dismissal:

```js
if (
  startSelectionMode && event.target === sentence &&
  (event.key === 'Enter' || event.key === ' ')
) {
  event.preventDefault();
  const index = Number(sentence.dataset.sentenceIndex);
  setStartSelectionMode(false);
  if (Number.isInteger(index)) startFullReading(index);
  return;
}
if (event.key === 'Escape' && startSelectionMode) {
  event.preventDefault();
  setStartSelectionMode(false);
  return;
}
```

Call `setStartSelectionMode(false)` from `startFullReading`, `render` cleanup preparation, and reader unmount.

- [ ] **Step 7: Add selection-mode styles**

In `public/styles.css`, add:

```css
.pc-reader-start-hint {
  margin-bottom: 10px;
  color: var(--ink-dim);
  font-size: 12.5px;
}
.pc-reader-start-hint[hidden] { display: none; }
.pc-reader-start-selecting .pc-reader-sentence {
  outline: 1px dashed color-mix(in srgb, var(--teal) 55%, transparent);
  outline-offset: 3px;
  cursor: crosshair;
}
.pc-reader-start-selecting .pc-reader-sentence:hover,
.pc-reader-start-selecting .pc-reader-sentence:focus-visible {
  outline: 3px solid var(--teal);
}
```

- [ ] **Step 8: Run focused and existing reader tests**

Run:

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all tests PASS, including existing single-sentence, selection, term-popover, keyboard, and cleanup tests.

- [ ] **Step 9: Commit**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "feat: choose an exact read-aloud start sentence"
```

---

### Task 3: Keep the Active Full-Reading Sentence Visible

**Files:**
- Modify: `public/reader-view.js`
- Test: `tests/reader-pending-dom.test.js`

**Interfaces:**
- Consumes: `applySpeechState(next)`, sentence `data-sentence-index`, `runtime.requestAnimationFrame`, `window.scrollY`, and `window.innerHeight`.
- Produces: runtime callback `prefersReducedMotion()` and helper `followSpeakingSentence(index)`.

- [ ] **Step 1: Write failing tests for safe-zone behavior**

Add a DOM test with injected `requestAnimationFrame: callback => callback()` and a captured `window.scrollTo`:

```js
const scrollCalls = [];
env.window.scrollTo = options => { scrollCalls.push(options); };
Object.defineProperty(env.window, 'innerHeight', {
  configurable: true, value: 800
});

const sentence = env.root.querySelector('[data-sentence-index="1"]');
sentence.getBoundingClientRect = () => ({
  top: 200, bottom: 300, height: 100
});
speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
assert.equal(scrollCalls.length, 0);
```

Then place a new current sentence below the `78%` lower boundary:

```js
const below = env.root.querySelector('[data-sentence-index="2"]');
below.getBoundingClientRect = () => ({
  top: 690, bottom: 760, height: 70
});
speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false } });
assert.equal(scrollCalls.length, 1);
assert.equal(scrollCalls[0].behavior, 'smooth');
assert.equal(scrollCalls[0].top, 434); // 0 + 690 - (800 * 0.32)
```

Emit the same sentence again and assert no second scroll:

```js
speech.emit({ state: 'speaking', currentIndex: 2, completion: { reachedEnd: false } });
assert.equal(scrollCalls.length, 1);
```

- [ ] **Step 2: Write failing tests for the upper boundary, pause, and reduced motion**

Add assertions:

```js
speech.emit({ state: 'paused', currentIndex: 2, completion: { reachedEnd: false } });
assert.equal(scrollCalls.length, 1);
```

In a second mount inject `prefersReducedMotion: () => true`, place the current sentence above `15%`, and assert:

```js
sentence.getBoundingClientRect = () => ({
  top: 20, bottom: 90, height: 70
});
speech.emit({ state: 'speaking', currentIndex: 1, completion: { reachedEnd: false } });
assert.equal(scrollCalls.at(-1).behavior, 'auto');
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="keeps the active|reduced motion" tests/reader-pending-dom.test.js
```

Expected: FAIL because speech state currently highlights sentences but never scrolls them into a safe viewport zone.

- [ ] **Step 4: Add the runtime dependency and follow helper**

Extend `runtime`:

```js
prefersReducedMotion: progressRuntime.prefersReducedMotion || (
  () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
)
```

Add state:

```js
let lastAutoFollowedSentenceIndex = null;
```

Add:

```js
function followSpeakingSentence(index) {
  if (!Number.isInteger(index) || index === lastAutoFollowedSentenceIndex) return;
  lastAutoFollowedSentenceIndex = index;
  runtime.requestAnimationFrame(() => {
    if (!mounted || speechState !== 'speaking') return;
    const sentence = root.querySelector(`[data-sentence-index="${index}"]`);
    if (!sentence) return;
    const rect = sentence.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 0;
    const safeTop = viewportHeight * 0.15;
    const safeBottom = viewportHeight * 0.78;
    if (rect.top >= safeTop && rect.bottom <= safeBottom) return;
    const top = Math.max(
      0,
      (window.scrollY || 0) + rect.top - (viewportHeight * 0.32)
    );
    window.scrollTo?.({
      top,
      behavior: runtime.prefersReducedMotion() ? 'auto' : 'smooth'
    });
  });
}
```

- [ ] **Step 5: Connect follow behavior to speech state**

At the end of `applySpeechState(next)`, after `speechState` and the active index are updated:

```js
if (nextState === 'speaking' && Number.isInteger(next?.currentIndex)) {
  followSpeakingSentence(next.currentIndex);
} else if (nextState !== 'speaking') {
  lastAutoFollowedSentenceIndex = null;
}
```

This excludes `once` single-sentence speech, pauses, idle states, and history loading.

- [ ] **Step 6: Run reader tests and verify GREEN**

Run:

```powershell
node --test tests/reader-pending-dom.test.js
```

Expected: all reader DOM tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add public/reader-view.js tests/reader-pending-dom.test.js
git commit -m "feat: keep the spoken sentence in view"
```

---

### Task 4: Full Regression Verification

**Files:**
- Verify only: all files changed in Tasks 1–3

**Interfaces:**
- Consumes: completed implementation and tests.
- Produces: evidence that syntax, DOM behavior, CSS contracts, API behavior, TTS fallback, and the full suite remain valid.

- [ ] **Step 1: Check reader syntax**

Run:

```powershell
node --check public/reader-view.js
```

Expected: exit code `0` with no syntax error.

- [ ] **Step 2: Run focused DOM and CSS tests**

Run:

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all tests PASS.

- [ ] **Step 3: Run speech and TTS regression tests**

Run:

```powershell
node --test tests/speech.test.js tests/tts-player.test.js tests/reading-session.test.js
```

Expected: all tests PASS, including Azure-to-browser fallback and progress queue behavior.

- [ ] **Step 4: Run the complete suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Check the final diff and worktree**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` reports no whitespace error; status contains only intended implementation/test changes if Task commits were intentionally deferred.

- [ ] **Step 6: Perform responsive browser checks**

At `320px`, `375px`, landscape-phone, touch-tablet, and desktop viewport sizes, verify:

1. Breakpoint summary and “跳转” stay on one line without horizontal overflow.
2. Toolbar offscreen + idle saved breakpoint shows “继续”.
3. Toolbar offscreen + idle no breakpoint shows “选择起点”.
4. Selecting a highlighted or plain sentence starts at the exact sentence.
5. The active sentence remains between roughly `15%` and `78%` of viewport height.
6. Word/selection bottom panels hide the floating capsule.
7. Reduced-motion mode uses an immediate jump.

- [ ] **Step 7: Commit any final verification-only corrections**

If verification required code or test corrections, repeat the failing-test-first cycle, then:

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "test: cover responsive read-aloud controls"
```

If no correction was required, do not create an empty commit.
