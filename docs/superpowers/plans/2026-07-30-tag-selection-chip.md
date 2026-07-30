# Tag Selection Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the enlarged native tag checkboxes with accessible selectable chips in every word-tag form.

**Architecture:** Keep the existing native checkbox and label markup so form submission, keyboard behavior, and JavaScript remain unchanged. Narrow the generic form-input selector so it no longer styles checkboxes, then make the shared `.pc-tag-choice` class render all tag choices as theme-aware chips driven by the checkbox state.

**Tech Stack:** Native HTML checkboxes, CSS custom properties and relational selectors, Node.js built-in test runner.

## Global Constraints

- The selected state must use both a color change and a visible check mark.
- The native checkbox must remain keyboard focusable and retain form semantics.
- The whole chip must be clickable with a minimum target height of 44 pixels.
- The styles must work in light and dark themes using existing theme variables.
- Both `public/words-view.js` and `public/pending-view.js` must receive the shared behavior without JavaScript changes.
- Tag loading, creation, retry, selection, and submission behavior must remain unchanged.

---

### Task 1: Accessible Tag Selection Chips

**Files:**
- Modify: `tests/static-shell.test.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Existing `label.pc-tag-choice > input[type="checkbox"] + text` markup and theme variables `--ink`, `--ink-dim`, `--bg-panel`, `--line`, and `--teal`.
- Produces: Shared visual states for unchecked, checked, hover, active, and `focus-visible` tag choices without changing DOM or JavaScript interfaces.

- [ ] **Step 1: Write the failing regression test**

Add this test to `tests/static-shell.test.js`:

```js
test('tag checkboxes render as accessible selected chips', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const choice = css.match(/\.pc-tag-choice\s*\{([^}]*)\}/)?.[1];
  const checkbox = css.match(/\.pc-tag-choice input\[type="checkbox"\]\s*\{([^}]*)\}/)?.[1];

  assert.ok(choice, 'tag choices should have a style rule');
  assert.match(choice, /min-height:\s*44px/);
  assert.match(choice, /border-radius:\s*999px/);
  assert.match(choice, /cursor:\s*pointer/);
  assert.ok(checkbox, 'native tag checkboxes should have a visually hidden rule');
  assert.match(checkbox, /position:\s*absolute/);
  assert.match(checkbox, /clip-path:\s*inset\(50%\)/);
  assert.match(css, /\.pc-tag-choice:has\(input:checked\)\s*\{[^}]*border-color:\s*var\(--teal\)/);
  assert.match(css, /\.pc-tag-choice:has\(input:checked\)::before\s*\{[^}]*content:\s*"✓"/);
  assert.match(css, /\.pc-tag-choice:has\(input:focus-visible\)\s*\{[^}]*outline:/);
  assert.match(css, /\.pc-form input:not\(\[type="checkbox"\]\),\s*\.pc-form textarea/);
});
```

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```powershell
node --test --test-name-pattern="tag checkboxes render as accessible selected chips" tests/static-shell.test.js
```

Expected: FAIL because `.pc-tag-choice` does not yet have a 44-pixel chip rule and the native checkbox is not visually hidden.

- [ ] **Step 3: Implement the minimal shared CSS**

In `public/styles.css`, narrow the generic form rules:

```css
.pc-form input:not([type="checkbox"]), .pc-form textarea {
  width: 100%; background: var(--bg-deep); border: 1px solid var(--line); border-radius: 7px;
  padding: 9px 10px; color: var(--ink); font-size: 14px; font-family: inherit;
}
.pc-form input:not([type="checkbox"]):focus, .pc-form textarea:focus {
  outline: none; border-color: var(--teal);
}
```

Replace the existing `.pc-tag-choice` rule with:

```css
.pc-tag-choice {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; min-height: 44px; margin: 0; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--bg-panel); color: var(--ink-dim);
  font-size: 12.5px; line-height: 1.2; cursor: pointer; user-select: none;
}
.pc-tag-choice input[type="checkbox"] {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%);
  white-space: nowrap; border: 0;
}
.pc-tag-choice::before {
  content: ""; display: inline-grid; place-items: center; flex: 0 0 14px;
  width: 14px; height: 14px; border-radius: 50%;
  color: var(--teal); font-size: 11px; font-weight: 800; line-height: 1;
  opacity: 0;
}
.pc-tag-choice:hover {
  border-color: color-mix(in srgb, var(--teal) 65%, var(--line));
  color: var(--ink);
}
.pc-tag-choice:active {
  background: color-mix(in srgb, var(--teal) 10%, var(--bg-panel));
}
.pc-tag-choice:has(input:checked) {
  border-color: var(--teal);
  background: color-mix(in srgb, var(--teal) 16%, var(--bg-panel));
  color: color-mix(in srgb, var(--teal) 78%, var(--ink));
  font-weight: 600;
}
.pc-tag-choice:has(input:checked)::before {
  content: "✓"; opacity: 1;
}
.pc-tag-choice:has(input:focus-visible) {
  outline: 3px solid color-mix(in srgb, var(--teal) 45%, transparent);
  outline-offset: 2px;
}
```

Change the tag layout gap to:

```css
.pc-tag-options { display: flex; flex-wrap: wrap; gap: 8px; }
```

- [ ] **Step 4: Run the regression test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="tag checkboxes render as accessible selected chips" tests/static-shell.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 5: Run focused UI tests**

Run:

```powershell
node --test tests/static-shell.test.js tests/ui-dom.test.js tests/reader-pending-dom.test.js
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 6: Run full verification**

Run:

```powershell
npm run test:all
git diff --check
```

Expected: all tests pass and `git diff --check` produces no output.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- public/styles.css tests/static-shell.test.js
git commit -m "fix: restyle tag selection as chips"
```
