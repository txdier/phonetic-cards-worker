# Reader Popover Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Constrain the pending organizer on desktop and replace the reader's inconsistent selection and term panels with one structured, state-aware popover.

**Architecture:** Keep the implementation inside the existing reader and pending view boundaries. Add small DOM builders in `public/reader-view.js` for icons, shared popover chrome, state content, and positioning; preserve the existing API and conversion form contracts. Express responsive layout and theme-aware visual states in `public/styles.css` and lock behavior down with existing jsdom and static CSS tests.

**Tech Stack:** Browser ES modules, DOM APIs, CSS custom properties, Node.js test runner, jsdom.

## Global Constraints

- Do not change API endpoints, database schema, conversion conflict handling, reading progress, or article speech state management.
- `.pc-pending-list` uses `max-width: 920px` and horizontal centering on PC while remaining fluid on narrow screens.
- All three reader popover states share close, word heading, separators, and the two-button speech utility footer.
- Clicking outside, pressing Escape, or activating close dismisses an idle popover and restores focus when the trigger remains connected.
- A submitting conversion form remains protected from dismissal.
- Do not add external font or runtime dependencies.
- Browser verification is performed manually by the user; implementation verification uses automated tests only.

---

### Task 1: Constrain the pending organizer

**Files:**
- Modify: `public/styles.css`
- Test: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: existing `.pc-pending-list` container rendered by `createPendingView`.
- Produces: a centered list with a 920px desktop maximum and fluid narrow-screen width.

- [ ] **Step 1: Write the failing CSS contract test**

Add an assertion that extracts `.pc-pending-list` and verifies `max-width: 920px` and `margin: 0 auto` while retaining `display: grid`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/static-shell.test.js`

Expected: FAIL because `.pc-pending-list` has no maximum width or centered margin.

- [ ] **Step 3: Implement the centered width rule**

Change the rule to the equivalent of:

```css
.pc-pending-list { width: 100%; max-width: 920px; margin: 0 auto; display: grid; gap: 14px; }
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test tests/static-shell.test.js`

Expected: PASS.

### Task 2: Build the shared three-state reader popover

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Test: `tests/reader-pending-dom.test.js`
- Test: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: `article`, `speech`, selected-text panel datasets, term button datasets, `localMarking(article, termId)`, `markSelection`, `unmarkLocal`, and `openConversion`.
- Produces: shared DOM roles `reader-popover-head`, `reader-popover-body`, and `reader-popover-tools`; actions `toggle-mark`, `pronounce-popover`, and `speech-start-popover`; panel datasets `sentenceIndex`, `speechText`, `normalizedText`, and marking identifiers.

- [ ] **Step 1: Add failing DOM tests for the shared skeleton**

Cover selection, pending, and detail states. Assert each panel contains a close button, word heading, bookmark button, body, and footer containing exactly “发音” and “从本句开始全文朗读”. Assert the marked state contains a ribbon and status row, while detail retains lemma, meaning, forms, example, and stress.

- [ ] **Step 2: Add failing interaction tests**

Assert selection marking transitions in place to the marked state; bookmark and text cancellation call the existing article marking DELETE endpoint; each state's full-reading action calls `speech.startAt()` with the containing sentence index; outside click closes and restores focus; submitting conversions ignore outside clicks.

- [ ] **Step 3: Run focused reader tests and verify failure**

Run: `node --test tests/reader-pending-dom.test.js`

Expected: FAIL because the shared roles, fixed utilities, bookmark toggle, and outside dismissal do not exist.

- [ ] **Step 4: Add focused popover DOM helpers**

In `public/reader-view.js`, add helpers that create inline SVG icons with DOM methods, build icon buttons, derive a trigger sentence index, and assemble shared popover chrome. All displayed data continues to use `textContent` through the existing `element()` helper.

- [ ] **Step 5: Render selection, marked, and detail bodies through the shared builder**

Replace the selection button strip and the separate pending/detail panel structures. Preserve existing datasets needed for POST, DELETE, conversion, pronunciation, and speech start behavior. Keep conversion form mounting unchanged.

- [ ] **Step 6: Wire bookmark, speech, and dismissal actions**

Route duplicate visual controls to the same mutation functions. After a successful POST, update local article state and rebuild the selection popover as marked without requiring another click. Add document pointer dismissal with containment and conversion-busy guards, and remove it during cleanup.

- [ ] **Step 7: Style the shared component**

Add theme-aware rules for a compact fixed desktop popover, serif word heading, absolute close control, active bookmark, ribbon, content sections, status row, primary/secondary actions, separators, and stable two-column speech footer. Under `max-width: 640px`, render the popover statically at full available width.

- [ ] **Step 8: Run focused tests and resolve regressions**

Run: `node --test tests/reader-pending-dom.test.js tests/static-shell.test.js`

Expected: PASS.

### Task 3: Verify the complete change

**Files:**
- Modify only if an automated test exposes an in-scope defect.

**Interfaces:**
- Consumes: the completed CSS and reader DOM implementation.
- Produces: automated evidence that existing APIs and UI behavior remain intact.

- [ ] **Step 1: Run syntax and whitespace checks**

Run: `node --check public/reader-view.js`

Expected: no output and exit code 0.

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Review the final diff**

Confirm that only the design/plan documents, `public/reader-view.js`, `public/styles.css`, and relevant tests changed, apart from the user's pre-existing `wrangler.toml` and supplied Markdown file.
