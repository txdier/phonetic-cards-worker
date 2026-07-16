# Reader Selection Speech Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make text selection mutually exclusive with sentence click playback, add a closable and grouped “start full reading here” action, remove the sentence-length start menu, and show the current speech rate.

**Architecture:** Keep all behavior in the existing reader view and speech controller interface. The selection panel captures its sentence index when created, owns its close lifecycle, and suppresses the browser click synthesized after a successful pointer selection; the top toolbar always starts at sentence zero and exposes a live rate label.

**Tech Stack:** Browser ES modules, DOM APIs, Web Speech abstraction, Node test runner, jsdom.

## Global Constraints

- Work directly on `codex/article-practice`; do not create a worktree.
- Do not modify, stage, or commit the user's `wrangler.toml` change.
- Full reading remains sentence-based; selection starts at the containing sentence's beginning.
- Full read-aloud counting still requires reaching the end with at least 80% sentence coverage.
- Preserve word lookup, pending conversion, marking, progress, speech accessibility, and existing wordbook behavior.
- Production changes require a failing regression test first.

---

### Task 1: Repair Selection and Speech Controls

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Test: `tests/reader-pending-dom.test.js`
- Test: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: `speech.speakOnce(text)`, `speech.startAt(sentenceIndex)`, `speech.setRate(rate)`, `validateSelection(...)`, and sentence nodes carrying `data-sentence-index`.
- Produces: selection panel actions `pronounce-selection`, `mark-selection`, `speech-start-selection`, and `close-selection`; rate output `data-role="speech-rate-value"`.

- [ ] **Step 1: Add failing event-sequence tests**

Add a DOM regression test that makes `pointerup` expose a valid selection, then makes the Selection collapsed before the browser's following `click`:

```js
let selected = true;
env.window.getSelection = () => selected ? validSelection(sentence) : {
  isCollapsed: true, rangeCount: 0, toString: () => ''
};
sentence.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
selected = false;
sentence.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
assert.equal(speech.calls.some(call => call[0] === 'speakOnce'), false);
```

In a separate assertion, click a sentence without a prior selection and require exactly one `speakOnce(sentence.textContent)` call.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern="selection suppresses|ordinary sentence click" tests/reader-pending-dom.test.js
```

Expected: the selection sequence incorrectly records `speakOnce`, while the ordinary click assertion documents the behavior that must remain.

- [ ] **Step 3: Add failing selection-menu lifecycle tests**

Require the real rendered panel to contain the four actions and its sentence index:

```js
const panel = env.root.querySelector('[data-role="selection-action"]');
assert.equal(panel.dataset.sentenceIndex, '1');
assert.ok(panel.querySelector('[data-action="pronounce-selection"]'));
assert.ok(panel.querySelector('[data-action="mark-selection"]'));
assert.ok(panel.querySelector('[data-action="speech-start-selection"]'));
assert.ok(panel.querySelector('[data-action="close-selection"]'));
```

Verify `close-selection`, Escape, and a click on reader text outside the selected sentence each remove the panel, call `removeAllRanges()` once, and do not call either speech method. Verify a click inside the panel does not trigger the outside-close path.

- [ ] **Step 4: Run the lifecycle tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="selection menu" tests/reader-pending-dom.test.js
```

Expected: FAIL because the start/close actions, sentence index, and close lifecycle do not exist.

- [ ] **Step 5: Add failing toolbar and long-article tests**

Render an article with 60 sentences and assert:

```js
assert.equal(env.root.querySelector('[data-action="speech-start"]'), null);
assert.equal(env.root.querySelectorAll('.pc-reader-speech option').length, 0);
click(env.window, env.root.querySelector('[data-action="speech-play"]'));
assert.deepEqual(speech.calls.at(-1), ['startAt', 0]);
```

For the selection panel whose `data-sentence-index` is `37`, click `speech-start-selection` and require `['startAt', 37]`, panel removal, and range clearing.

Require `[data-role="speech-rate-value"]` to start at `1×` and update to `0.5×` and `1.5×` after real input events while `setRate` receives the same numeric value.

- [ ] **Step 6: Run toolbar tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="long article|rate value|start full reading" tests/reader-pending-dom.test.js
```

Expected: FAIL because the toolbar still generates one option per sentence and has no rate output or selection-start action.

- [ ] **Step 7: Implement the minimal selection state machine**

In `createReaderView`, keep a boolean that is armed only when `handleSelection()` successfully renders a panel. Consume it in `onSentenceClick` before reading Selection state, so the synthesized click is ignored exactly once. Clear it during menu close, reload, and unmount.

Extract one close function for the selection panel:

```js
function closeSelection() {
  root.querySelector('[data-role="selection-host"]')?.replaceChildren();
  window.getSelection?.()?.removeAllRanges?.();
  suppressNextSentenceClick = false;
}
```

Store `startNode.dataset.sentenceIndex` on the panel. Render grouped actions with a separate `.pc-selection-reading` container for `speech-start-selection`, plus `close-selection`. Extend Escape and outside-reader-click handling without changing term/conversion popover behavior.

- [ ] **Step 8: Implement compact speech controls**

Delete the start `<select>` and its sentence-option loop. Make toolbar Play call:

```js
speech.startAt(0);
```

Make the selection-start action read the captured integer sentence index, close the selection, and call `speech.startAt(index)` exactly once.

Append a rate value node next to the range input:

```js
const rateValue = element('output', 'pc-speech-rate-value', `${Number(rate.value)}×`);
rateValue.dataset.role = 'speech-rate-value';
```

Update it after `speech.setRate(event.target.value)` using the returned controller rate when available, otherwise the range value. Keep the value textual for screen-reader and visual users.

- [ ] **Step 9: Style the grouped menu and rate output**

Add a border or spacing separator around `.pc-selection-reading`, keep all actions wrapping within the existing panel, and style `.pc-speech-rate-value` with tabular figures and sufficient contrast. Preserve the mobile in-flow rule and 44px targets. Add a static CSS assertion that the new group does not use fixed width or overflow-producing positioning.

- [ ] **Step 10: Run focused and full verification**

Run:

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
npm run test:all
Get-ChildItem public -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
git status --short
```

Expected: every focused and full test passes, syntax and whitespace checks are clean, and only intended files plus the user's unstaged `wrangler.toml` appear.

- [ ] **Step 11: Commit**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "fix: refine reader selection speech controls"
```

---

### Task 2: Independent Review

**Files:**
- Review: `public/reader-view.js`
- Review: `public/styles.css`
- Review: `tests/reader-pending-dom.test.js`
- Review: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: Task 1 commit and the approved design spec.
- Produces: approval with no Critical or Important findings, or a focused correction commit.

- [ ] **Step 1: Review event ordering and cleanup**

Check pointerup/click suppression, ordinary sentence playback, menu-inside versus outside clicks, Escape, range clearing, reload, and unmount. Confirm no stale suppression can discard a later legitimate sentence click.

- [ ] **Step 2: Review speech behavior and accessibility**

Confirm toolbar Play starts at zero, selection starts at its captured sentence, the removed select leaves no per-sentence DOM growth, rate text matches the actual rate, and live speech announcements/statistics remain unchanged.

- [ ] **Step 3: Run fresh verification**

Run the focused tests, `npm run test:all`, JavaScript syntax checks, and `git diff --check`. Any Critical or Important finding must receive a failing regression test and correction before approval.

