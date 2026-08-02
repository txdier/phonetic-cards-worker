# Mobile Floating Speech Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the floating read-aloud speed control and keep all five controls complete on one row by using icon-only mobile presentation.

**Architecture:** Keep control behavior in `public/reader-view.js` and responsive presentation in `public/styles.css`. Render stable SVG-and-label button contents so CSS can hide only visible labels on phone widths while `aria-label` preserves semantics; reuse the existing `speech-rate-cycle` handler and synchronize it with the top toolbar.

**Tech Stack:** Native JavaScript DOM APIs, CSS media queries, Node.js test runner, JSDOM.

## Global Constraints

- The floating bar remains a single row and never uses horizontal scrolling.
- The control order is previous, replay current, primary action, timer, speed.
- Phone widths hide visible labels for the first four controls; speed continues to show the current multiplier.
- Each control keeps a minimum 44×44px touch target.
- Supported rates cycle exactly through `0.5`, `0.75`, `1`, `1.25`, and `1.5`.
- Existing read-aloud state, replay, checkpoint, timer, and completion behavior must not change.
- The layout must fit 320px and 375px portrait viewports and mobile landscape without clipping, wrapping, or horizontal scrolling.

---

### Task 1: Restore and synchronize the floating speed control

**Files:**
- Modify: `tests/reader-pending-dom.test.js:812-890`
- Modify: `public/reader-view.js:65-105`
- Modify: `public/reader-view.js:646-680`
- Modify: `public/reader-view.js:715-745`
- Modify: `public/reader-view.js:966-998`

**Interfaces:**
- Consumes: existing `speechAction(selectableStart)`, `svgIcon(name)`, `(tts || speech).getRate()`, `(tts || speech).setRate(rate)`, and `syncSpeechControls()`.
- Produces: a `[data-action="speech-rate-cycle"]` button with `[data-role="floating-speech-rate"]`; stable `.pc-floating-speech-label` spans; dynamic SVG primary action and timer content.

- [ ] **Step 1: Write the failing DOM behavior test**

Extend `reader exposes direct replay and sleep timer controls for touch use` so it expects five controls in this exact order and verifies the rate cycle:

```js
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

const floatingRate = env.root.querySelector('[data-action="speech-rate-cycle"]');
assert.equal(floatingRate.textContent.trim(), '1×');
assert.equal(floatingRate.getAttribute('aria-label'), '切换朗读语速，当前 1 倍');
for (const expected of [1.25, 1.5, 0.5, 0.75, 1]) {
  click(env.window, floatingRate);
  assert.equal(env.tts.controller.getRate(), expected);
  assert.equal(env.root.querySelector('[data-action="speech-rate"]').value, String(expected));
  assert.equal(floatingRate.textContent.trim(), `${expected}×`);
}
```

Also assert that previous, current, primary, and timer buttons contain SVG elements and `.pc-floating-speech-label` spans while speed remains readable text.

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```powershell
node --test --test-name-pattern "reader exposes direct replay and sleep timer controls for touch use" tests/reader-pending-dom.test.js
```

Expected: FAIL because the floating action list has four items and `[data-action="speech-rate-cycle"]` is missing.

- [ ] **Step 3: Add stable floating button content and icons**

Add `pause`, `timer`, and `target` paths to `POPOVER_ICONS`. Add a focused helper:

```js
function floatingIconButton(action, label, icon) {
  const node = actionButton(action, '', 'pc-floating-speech-action');
  node.append(svgIcon(icon), element('span', 'pc-floating-speech-label', label));
  return node;
}
```

Extend `speechAction()` return values with `icon`: `pause` while speaking, `play` while paused or resumable, `close` while cancelling selection, and `target` while selecting a start sentence.

Build the capsule with `floatingIconButton` for previous, current, primary, and timer, then append:

```js
const rate = actionButton('speech-rate-cycle', '', 'pc-floating-speech-action pc-floating-speech-rate');
rate.dataset.role = 'floating-speech-rate';
rate.dataset.speechControl = '';
rate.disabled = !Boolean((tts || speech)?.isSupported);
capsule.append(previous, current, toggle, timer, rate);
```

- [ ] **Step 4: Synchronize dynamic contents without deleting SVG icons**

In `syncSpeechControls()`, update the floating rate and primary button as structured content:

```js
const floatingRate = root.querySelector('[data-role="floating-speech-rate"]');
if (floatingRate) {
  floatingRate.textContent = `${rate}×`;
  floatingRate.setAttribute('aria-label', `切换朗读语速，当前 ${rate} 倍`);
}
const toggle = root.querySelector('[data-role="floating-speech-toggle"]');
if (toggle) {
  const action = speechAction(true);
  toggle.replaceChildren(
    svgIcon(action.icon),
    element('span', 'pc-floating-speech-label', action.label)
  );
  toggle.setAttribute('aria-label', action.ariaLabel);
}
```

In `syncTimerControls()`, replace only the floating timer contents: show the remaining time as `.pc-floating-speech-timer-value` when active; otherwise restore the timer SVG and `.pc-floating-speech-label`.

- [ ] **Step 5: Run the targeted DOM test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern "reader exposes direct replay and sleep timer controls for touch use" tests/reader-pending-dom.test.js
```

Expected: PASS with all five actions, the full rate cycle, structured icons, and synchronized top controls.

- [ ] **Step 6: Commit the behavior change**

```powershell
git add -- public/reader-view.js tests/reader-pending-dom.test.js
git commit -m "fix: restore floating speech speed control"
```

---

### Task 2: Keep five controls complete on one mobile row

**Files:**
- Modify: `tests/static-shell.test.js:203-229`
- Modify: `public/styles.css:333-358`
- Modify: `public/styles.css:704-768`

**Interfaces:**
- Consumes: `.pc-floating-speech`, `.pc-floating-speech-action`, `.pc-floating-speech-label`, `.pc-floating-speech-rate`, and `.pc-floating-speech-timer-value` emitted by Task 1.
- Produces: a five-column desktop capsule and a five-equal-column phone layout that hides only visible labels.

- [ ] **Step 1: Replace the four-control CSS contract with a failing five-control mobile contract**

Rename the static test to `mobile speech capsule keeps five complete controls on one row` and assert:

```js
assert.match(capsule, /grid-template-columns:\s*repeat\(5,\s*minmax\(44px,\s*auto\)\)/);
assert.match(capsule, /max-width:\s*calc\(100vw\s*-\s*24px\)/);
assert.match(phoneAndCoarseTablet, /\.pc-floating-speech\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(44px,\s*1fr\)\)/);
assert.match(phoneAndCoarseTablet, /\.pc-floating-speech-label\s*\{[^}]*display:\s*none/);
assert.match(phoneAndCoarseTablet, /\.pc-floating-speech-action\s*\{[^}]*min-width:\s*44px/);
assert.match(phoneAndCoarseTablet, /\.pc-floating-speech-action\s+svg\s*\{[^}]*width:\s*18px/);
assert.doesNotMatch(phoneAndCoarseTablet, /overflow-x:\s*(?:auto|scroll)/);
```

Retain assertions for `min-height: 44px`, safe-area placement, focus visibility, disabled state, and `touch-action: manipulation`.

- [ ] **Step 2: Run the static test and verify RED**

Run:

```powershell
node --test --test-name-pattern "mobile speech capsule keeps five complete controls on one row" tests/static-shell.test.js
```

Expected: FAIL because the base layout still has four columns and the mobile icon-only rules do not exist.

- [ ] **Step 3: Implement the five-column responsive CSS**

Change the base capsule and action styles to:

```css
.pc-floating-speech {
  grid-template-columns: repeat(5, minmax(44px, auto));
}
.pc-floating-speech-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.pc-floating-speech-action svg {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
}
.pc-floating-speech-rate,
.pc-floating-speech-timer-value {
  font-variant-numeric: tabular-nums;
}
```

Inside the existing phone/coarse-pointer media query, add:

```css
.pc-floating-speech {
  width: calc(100vw - 24px);
  grid-template-columns: repeat(5, minmax(44px, 1fr));
  gap: 4px;
  padding-inline: 4px;
}
.pc-floating-speech-action {
  min-width: 44px;
  padding-inline: 4px;
}
.pc-floating-speech-label { display: none; }
```

Remove the obsolete `max-width: 380px` padding/font workaround for floating actions. Do not add wrapping or horizontal overflow.

- [ ] **Step 4: Run static and DOM regression tests and verify GREEN**

Run:

```powershell
node --test tests/static-shell.test.js tests/reader-pending-dom.test.js
```

Expected: PASS with no assertion failures.

- [ ] **Step 5: Commit the responsive layout**

```powershell
git add -- public/styles.css tests/static-shell.test.js
git commit -m "fix: fit speech controls on phone screens"
```

---

### Task 3: Full verification

**Files:**
- Verify: `public/reader-view.js`
- Verify: `public/styles.css`
- Verify: `tests/reader-pending-dom.test.js`
- Verify: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: the completed DOM behavior and responsive CSS from Tasks 1 and 2.
- Produces: evidence that the focused fix does not regress the repository test suite.

- [ ] **Step 1: Run whitespace and diff validation**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional implementation files are listed if commits have not yet been created.

- [ ] **Step 2: Run the full automated suite**

```powershell
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Review the final diff against the confirmed design**

```powershell
git diff HEAD~2 -- public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: five ordered controls, rate synchronization, structured SVG buttons, phone-only label hiding, five equal phone columns, and no unrelated refactor.

- [ ] **Step 4: Record manual device checks for handoff**

Report that automated contracts cover 320px and 375px sizing rules, then ask the user to verify actual iPhone Safari and Android Chrome rendering because JSDOM cannot reproduce browser safe-area and font rasterization behavior.
