# Reader Sentence Translation Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle sentence translation mode as a continuous article with quiet Chinese annotations and compact, accessible translation controls.

**Architecture:** Keep the existing translation state machine and API calls unchanged. Adjust the sentence-slot markup only enough to distinguish idle text actions from translated refresh icon actions, then implement the approved hierarchy entirely with existing reader classes and theme tokens.

**Tech Stack:** Browser DOM APIs, vanilla JavaScript, CSS, Node.js test runner, JSDOM.

## Global Constraints

- English remains the primary reading layer and keeps user-selected reader typography.
- Chinese translations use 82–86% of the original size, `Noto Sans SC`, and existing secondary color tokens.
- Controls remain native buttons with at least 44×44 CSS pixel hit areas.
- Long translations wrap naturally and are never clamped.
- Original mode, full translation mode, API contracts, caching, sentence indexes, highlighting, selection, and read-aloud behavior remain unchanged.

---

### Task 1: Quiet Translation Actions and Annotation Layout

**Files:**
- Modify: `tests/reader-pending-dom.test.js`
- Modify: `tests/static-shell.test.js`
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: existing `fillSentenceTranslationSlot(slot, sentenceIndex)`, `svgIcon(name)`, sentence translation state maps, and CSS theme variables.
- Produces: `.pc-sentence-translation-action-label`, `.pc-sentence-translation-refresh`, and the approved annotation-gutter layout without changing data attributes or API behavior.

- [ ] **Step 1: Write failing DOM assertions**

Extend the sentence translation DOM test so an idle action contains a visible label, and a cached translation uses an icon-only refresh button with a complete accessible name:

```js
const idleAction = slot.querySelector('[data-action="translate-sentence"]');
assert.equal(idleAction.querySelector('.pc-sentence-translation-action-label').textContent, '翻译本句');

const refresh = slot.querySelector('[data-action="refresh-sentence-translation"]');
assert.ok(refresh.classList.contains('pc-sentence-translation-refresh'));
assert.ok(refresh.querySelector('svg'));
assert.equal(refresh.getAttribute('aria-label'), '重新翻译');
```

- [ ] **Step 2: Write failing CSS assertions**

Replace the old card/overlay expectations with assertions for a transparent annotation gutter, smaller Chinese text, an explicit 44px refresh hit target, larger paragraph rhythm, and no text clamping:

```js
assert.match(paragraph || '', /gap:\s*1em/);
assert.match(slot || '', /border-left:\s*2px\s+solid/);
assert.match(slot || '', /background:\s*transparent/);
assert.match(translated || '', /font-size:\s*\.84em/);
assert.match(refresh || '', /width:\s*44px/);
assert.doesNotMatch(translated || '', /line-clamp|overflow:\s*hidden|max-height/);
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
node --test --test-name-pattern="sentence translation" tests/reader-pending-dom.test.js
node --test --test-name-pattern="sentence translation slots" tests/static-shell.test.js
```

Expected: failures because the new label/refresh classes and annotation CSS do not exist yet.

- [ ] **Step 4: Implement minimal markup changes**

In `fillSentenceTranslationSlot`, keep the existing action and accessible label. For cached translations, add `pc-sentence-translation-refresh` and append `svgIcon('replay')`. For uncached translations, append a visible `译` glyph and `.pc-sentence-translation-action-label` containing the current action label. Do not change state transitions, focus restoration, or API calls.

- [ ] **Step 5: Implement the approved CSS hierarchy**

Update the sentence-mode rules so:

```css
.pc-reader-paragraph-sentence-mode { display: grid; gap: 1em; }
.pc-reader-sentence-unit { display: grid; gap: .28em; }
.pc-sentence-translation-slot {
  min-height: 44px;
  padding-inline-start: 14px;
  border-left: 2px solid color-mix(in srgb, var(--teal) 34%, var(--line));
  border-radius: 0;
  background: transparent;
}
.pc-sentence-translation-text {
  font-size: .84em;
  line-height: 1.7;
  font-family: 'Noto Sans SC', sans-serif;
}
.pc-sentence-translation-refresh { width: 44px; min-width: 44px; min-height: 44px; }
```

Use grid placement to keep cached translation text in the main column and the refresh action at the far edge. Keep idle/retry actions left-aligned inside the annotation gutter. Add a narrow-screen rule reducing gutter padding from 14px to 10px.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```powershell
node --test --test-name-pattern="sentence translation" tests/reader-pending-dom.test.js
node --test --test-name-pattern="sentence translation slots" tests/static-shell.test.js
```

Expected: all selected tests pass.

- [ ] **Step 7: Run the full verification suite**

Run:

```powershell
npm.cmd test
git diff --check
```

Expected: all tests pass and `git diff --check` exits 0.
