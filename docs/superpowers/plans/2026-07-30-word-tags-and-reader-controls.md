# Word Tags and Reader Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create and select tags while adding words, show “上次暂停” only for a real pause, add 0.75× and 1.25× speeds, and replace the ambiguous “本句” label with an icon-assisted “重听”.

**Architecture:** Keep the existing API and player contracts. Add local word-form tag state and DOM updates in `words-view.js`; separate the reader’s durable resume position from its pause-marker presentation state in `reader-view.js`; reuse the existing SVG helper for replay icons and add only scoped CSS.

**Tech Stack:** Native HTML/CSS/JavaScript ES modules, Cloudflare Worker JSON APIs, Node.js test runner, JSDOM.

## Global Constraints

- Speed values are exactly `0.5`, `0.75`, `1`, `1.25`, and `1.5`.
- The visible replay labels are exactly “上一句” and “重听”.
- “上一句” has `aria-label="重播上一句"`; “重听” has `aria-label="重新朗读当前句"`.
- Normal playback and automatic sentence changes never render or move “上次暂停”.
- Existing `/api/tags`, word `tagIds`, TTS, and progress API contracts remain compatible.
- A failed or late tag request must not discard or mutate a replaced word form.

---

### Task 1: Add and select tags inside the word form

**Files:**
- Modify: `public/words-view.js`
- Modify: `public/styles.css`
- Test: `tests/ui-dom.test.js`

**Interfaces:**
- Consumes: `api('/api/tags', { method: 'POST', body: JSON.stringify({ name }) })`
- Produces: word-form controls `[data-role="new-tag-input"]`, `[data-action="create-word-tag"]`, `[data-role="word-tag-options"]`, and `[data-role="word-tag-error"]`

- [ ] **Step 1: Write failing tests for existing selection, tag creation, failures, and stale responses**

Add focused JSDOM tests that open the add form and assert:

```js
const existing = form.querySelector('input[name="tagIds"][value="tag-existing"]');
assert.ok(existing);
existing.checked = true;
form.querySelector('#f-en').value = 'deploy';
form.querySelector('#f-zh').value = '部署';
form.querySelector('[data-role="new-tag-input"]').value = '云平台';
click(env.window, form.querySelector('[data-action="create-word-tag"]'));
await flush();
assert.equal(form.querySelector('input[value="tag-new"]').checked, true);
assert.equal(form.querySelector('#f-en').value, 'deploy');
assert.equal(form.querySelector('#f-zh').value, '部署');
click(env.window, form.querySelector('[data-action="submit-form"]'));
await flush();
assert.deepEqual(JSON.parse(saveCall.init.body).tagIds.sort(), ['tag-existing', 'tag-new']);
```

Use one rejected request to assert the error text and retained input, and one deferred request followed by cleanup to assert that a late response does not touch the detached form.

- [ ] **Step 2: Run the tag tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="word form.*tag|tag request" tests/ui-dom.test.js
```

Expected: FAIL because the add form has no in-place tag creation controls and no stale-request guard.

- [ ] **Step 3: Implement minimal word-form tag state and controls**

In `createWordsView`, add a form generation counter and tag-load error:

```js
let wordFormGeneration = 0;
let tagLoadError = '';
```

Render a creation row and options host inside the fieldset:

```js
<div class="pc-tag-create">
  <label>新标签<input data-role="new-tag-input" maxlength="50"></label>
  <button type="button" class="pc-btn-ghost" data-action="create-word-tag">新建</button>
</div>
<div class="pc-tag-options" data-role="word-tag-options">${tagChoices(selected)}</div>
<div class="pc-tag-error" data-role="word-tag-error" role="alert">${escapeHtml(tagLoadError)}</div>
```

Implement `createWordTag(button)` so it snapshots the current generation, disables the button, posts the trimmed name, deduplicates `tags` by ID, appends or selects the returned checkbox in the still-connected field, clears the input/error on success, and writes the error on failure only when the generation and field still match. Increment the generation whenever `render()` replaces the form.

When `/api/tags` loading fails, retain an explicit error instead of silently treating it as an empty list.

- [ ] **Step 4: Add scoped tag layout styles**

Extend the existing `.pc-tag-create`, `.pc-tag-options`, and `.pc-tag-error` rules so they apply inside `.pc-tag-field`, keep a 44px create button, wrap choices, and collapse the creation row to one column on narrow screens.

- [ ] **Step 5: Run the tag tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="word form.*tag|tag request" tests/ui-dom.test.js
```

Expected: all matching tests PASS.

- [ ] **Step 6: Commit the tag-form change**

```powershell
git add public/words-view.js public/styles.css tests/ui-dom.test.js
git commit -m "fix: add tags from word form"
```

---

### Task 2: Separate the real pause marker from live resume progress

**Files:**
- Modify: `public/reader-view.js`
- Test: `tests/reader-pending-dom.test.js`

**Interfaces:**
- Consumes: player snapshots with `state`, `articleId`, `currentIndex`, and `currentTime`
- Produces: internal `pausedAloudSentenceIndex` used exclusively to render `[data-role="aloud-resume-marker"]`

- [ ] **Step 1: Write failing pause-marker state tests**

Add a JSDOM regression test that starts playback, emits two speaking snapshots, and then pauses:

```js
click(env.window, env.root.querySelector('[data-action="speech-primary"]'));
env.tts.controller.emit({
  state: 'speaking', mode: 'article', articleId: 'a1',
  currentIndex: 0, currentTime: 1, completion: { reachedEnd: false }
});
assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);
env.tts.controller.emit({
  state: 'speaking', mode: 'article', articleId: 'a1',
  currentIndex: 1, currentTime: 0, completion: { reachedEnd: false }
});
assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);
env.tts.controller.emit({
  state: 'paused', mode: 'article', articleId: 'a1',
  currentIndex: 1, currentTime: 2, completion: { reachedEnd: false }
});
assert.equal(
  env.root.querySelector('[data-role="aloud-resume-marker"]').nextElementSibling.dataset.sentenceIndex,
  '1'
);
env.tts.controller.emit({
  state: 'speaking', mode: 'article', articleId: 'a1',
  currentIndex: 1, currentTime: 2, completion: { reachedEnd: false }
});
assert.equal(env.root.querySelector('[data-role="aloud-resume-marker"]'), null);
```

Also preserve the existing assertion that a loaded local/server checkpoint initially renders at its saved sentence.

- [ ] **Step 2: Run the marker test and verify RED**

Run:

```powershell
node --test --test-name-pattern="pause marker|resume marker" tests/reader-pending-dom.test.js
```

Expected: FAIL because `setSavedAloudPosition()` currently inserts “上次暂停” during every speaking checkpoint.

- [ ] **Step 3: Implement independent pause-marker presentation state**

Add:

```js
let pausedAloudSentenceIndex = null;

function setPausedAloudPosition(index) {
  pausedAloudSentenceIndex = validAloudIndex(index) ? index : null;
  root.querySelector('[data-role="aloud-resume-marker"]')?.remove();
  if (!validAloudIndex(pausedAloudSentenceIndex)) return;
  const sentence = root.querySelector(`[data-sentence-index="${pausedAloudSentenceIndex}"]`);
  if (!sentence) return;
  const marker = element('span', 'pc-aloud-resume-marker', '上次暂停');
  marker.dataset.role = 'aloud-resume-marker';
  marker.setAttribute('aria-hidden', 'true');
  sentence.before(marker);
}
```

Make `setSavedAloudPosition()` update only durable resume data and the resume entry. Initialize `pausedAloudSentenceIndex` from a restored non-live checkpoint before `render()`. In `applySpeechState()`, set the paused position only on a transition to `paused`; clear it when state becomes `speaking` or after natural completion. `renderBody()` reads `pausedAloudSentenceIndex`, not `savedAloudSentenceIndex`.

- [ ] **Step 4: Run marker tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="pause marker|resume marker|checkpoint" tests/reader-pending-dom.test.js
```

Expected: all matching tests PASS.

- [ ] **Step 5: Commit the pause-marker fix**

```powershell
git add public/reader-view.js tests/reader-pending-dom.test.js
git commit -m "fix: show marker only after read-aloud pauses"
```

---

### Task 3: Add five speed levels and clearer icon-assisted replay controls

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Test: `tests/reader-pending-dom.test.js`

**Interfaces:**
- Consumes: existing `audioController.getRate()` and `audioController.setRate(value)`
- Produces: range input `{ min: "0.5", max: "1.5", step: "0.25" }`; replay buttons containing an SVG and visible label

- [ ] **Step 1: Write failing speed and replay-control tests**

Update the rate contract and add exact intermediate-value assertions:

```js
assert.deepEqual([rate.min, rate.max, rate.step, rate.value], ['0.5', '1.5', '0.25', '1']);
for (const value of ['0.75', '1.25']) {
  rate.value = value;
  rate.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  assert.deepEqual(speech.calls.at(-1), ['setRate', Number(value)]);
  assert.equal(rateValue.textContent, `${value}×`);
}
```

Assert both top and floating replay pairs:

```js
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
```

- [ ] **Step 2: Run the control tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="rate value|sequenced controls|replay controls" tests/reader-pending-dom.test.js
```

Expected: FAIL because the step is `0.5`, intermediate speeds are unavailable, labels say “本句”, and the buttons have no icons.

- [ ] **Step 3: Implement speed values and replay button rendering**

Add `previous` and `replay` paths to `POPOVER_ICONS`, and create:

```js
function speechReplayButton(action, label, icon, className = '') {
  const button = actionButton(action, '', className);
  button.classList.add('pc-speech-replay-action');
  button.append(svgIcon(icon), element('span', '', label));
  return button;
}
```

Use this helper for the four top/floating previous/current buttons, with “重听” and `aria-label="重新朗读当前句"` for current replay. Change the range step to `0.25`. Change the optional rate cycle to:

```js
const rates = [0.5, 0.75, 1, 1.25, 1.5];
const index = rates.indexOf(current);
const nextRate = rates[(index + 1 + rates.length) % rates.length];
```

- [ ] **Step 4: Add scoped icon styles**

Add `.pc-speech-replay-action` flex alignment and a `16px` non-shrinking SVG. Preserve the existing 44px touch target and the 320px floating-capsule fit.

- [ ] **Step 5: Run control tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="rate value|sequenced controls|replay controls" tests/reader-pending-dom.test.js
```

Expected: all matching tests PASS.

- [ ] **Step 6: Run full verification**

Run:

```powershell
npm run test:all
git diff --check
```

Expected: zero test failures and no whitespace errors.

- [ ] **Step 7: Commit the reader-control change**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js
git commit -m "feat: clarify read-aloud replay controls"
```
