# Compact Color Tag Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tag-selection chips 32 pixels high, center their text, and distinguish selection only with theme colors.

**Architecture:** Retain the existing native checkbox and shared `.pc-tag-choice` label markup so JavaScript, form submission, keyboard behavior, and screen-reader state remain unchanged. Limit the implementation to the shared CSS rules and their static regression test by removing the check-mark pseudo-element and tightening the chip layout.

**Tech Stack:** Native HTML checkboxes, CSS custom properties and relational selectors, Node.js built-in test runner.

## Global Constraints

- Tag chips must be 32 pixels high on every device.
- Unchecked tag text must be horizontally and vertically centered.
- Checked and unchecked states must differ only through background, border, and text color.
- No check mark, icon, dot, underline, label, or reserved marker space may remain.
- Native checkbox semantics, Tab focus, Space-key toggling, screen-reader checked state, focus rings, and disabled behavior must remain intact.
- Both word add/edit and pending-conversion forms must continue to use the shared style without JavaScript changes.
- Checked text contrast against its background must remain at least 4.5:1 in light and dark themes.

---

### Task 1: Compact Centered Color Chips

**Files:**
- Modify: `tests/static-shell.test.js:30-58`
- Modify: `public/styles.css:528-568`

**Interfaces:**
- Consumes: Existing `label.pc-tag-choice > input[type="checkbox"] + text` markup and theme variables `--ink`, `--ink-dim`, `--bg-panel`, `--line`, and `--teal`.
- Produces: A shared 32-pixel chip whose checked state uses only theme colors while retaining the native checkbox contract.

- [ ] **Step 1: Update the regression test for the new visual contract**

Replace the `tag checkboxes render as accessible selected chips` test in
`tests/static-shell.test.js` with:

```js
test('tag checkboxes render as compact centered color chips', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const choice = css.match(/\.pc-tag-choice\s*\{([^}]*)\}/)?.[1];
  const checkbox = css.match(/\.pc-tag-choice input\[type="checkbox"\]\s*\{([^}]*)\}/)?.[1];
  const checked = css.match(/\.pc-tag-choice:has\(input:checked\)\s*\{([^}]*)\}/)?.[1];

  assert.ok(choice, 'tag choices should have a style rule');
  assert.match(choice, /min-height:\s*32px/);
  assert.match(choice, /padding:\s*4px 11px/);
  assert.match(choice, /align-items:\s*center/);
  assert.match(choice, /justify-content:\s*center/);
  assert.match(choice, /border-radius:\s*999px/);
  assert.match(choice, /max-width:\s*100%/);
  assert.match(choice, /white-space:\s*nowrap/);
  assert.match(choice, /overflow:\s*hidden/);
  assert.match(choice, /cursor:\s*pointer/);
  assert.ok(checkbox, 'native tag checkboxes should have a visually hidden rule');
  assert.match(checkbox, /position:\s*absolute/);
  assert.match(checkbox, /clip-path:\s*inset\(50%\)/);
  assert.ok(checked, 'checked tag choices should have a color state');
  assert.match(checked, /border-color:\s*var\(--teal\)/);
  assert.match(checked, /background:\s*color-mix/);
  assert.match(checked, /color:\s*color-mix/);
  assert.doesNotMatch(checked, /font-weight/);
  assert.doesNotMatch(css, /\.pc-tag-choice(?::has\(input:checked\))?::before\s*\{/);
  assert.match(css, /\.pc-tag-choice:has\(input:focus-visible\)\s*\{[^}]*outline:/);
  assert.match(css, /\.pc-form input:not\(\[type="checkbox"\]\),\s*\.pc-form textarea/);
  assert.match(css, /\.pc-form label:not\(\.pc-tag-choice\)\s*\{/);
});
```

- [ ] **Step 2: Run the updated regression test and verify RED**

Run:

```powershell
node --test --test-name-pattern="tag checkboxes render as compact centered color chips" tests/static-shell.test.js
```

Expected: FAIL because the current rule still uses `min-height: 44px`, lacks
`justify-content: center`, and contains check-mark pseudo-element rules.

- [ ] **Step 3: Implement the compact color-only CSS**

In `public/styles.css`, replace the base `.pc-tag-choice` rule with:

```css
.pc-tag-choice {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  min-width: 0; max-width: 100%; min-height: 32px; margin: 0; padding: 4px 11px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--bg-panel); color: var(--ink-dim);
  font-size: 12.5px; line-height: 1.2; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; cursor: pointer; user-select: none;
}
```

Delete both pseudo-element rules:

```css
.pc-tag-choice::before {
  content: ""; display: inline-grid; place-items: center; flex: 0 0 14px;
  width: 14px; height: 14px; border-radius: 50%;
  color: var(--teal); font-size: 11px; font-weight: 800; line-height: 1;
  opacity: 0;
}
.pc-tag-choice:has(input:checked)::before {
  content: "✓"; opacity: 1;
}
```

Keep the checked color rule but remove its font-weight change:

```css
.pc-tag-choice:has(input:checked) {
  border-color: var(--teal);
  background: color-mix(in srgb, var(--teal) 16%, var(--bg-panel));
  color: color-mix(in srgb, var(--teal) 78%, var(--ink));
}
```

Do not change the visually hidden checkbox, hover, active, disabled, or focus rules.

- [ ] **Step 4: Run the regression test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="tag checkboxes render as compact centered color chips" tests/static-shell.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 5: Run focused UI tests**

Run:

```powershell
node --test tests/static-shell.test.js tests/ui-dom.test.js tests/reader-pending-dom.test.js
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 6: Verify color contrast and the full suite**

Run the selected text/background contrast calculation:

```powershell
node -e "function mix(a,b,p){return a.map((v,i)=>Math.round(v*p+b[i]*(1-p)))};function lum(c){let v=c.map(x=>{x/=255;return x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4)});return .2126*v[0]+.7152*v[1]+.0722*v[2]};function ratio(a,b){let x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};let lt=[31,143,125],li=[36,28,19],lp=[255,255,255],dt=[79,182,166],di=[237,231,218],dp=[26,35,46];console.log({light:ratio(mix(lt,li,.78),mix(lt,lp,.16)),dark:ratio(mix(dt,di,.78),mix(dt,dp,.16))})"
```

Expected: `light` is approximately `4.50` and `dark` is approximately `5.64`.

Then run:

```powershell
npm.cmd run test:all
git diff --check
```

Expected: light-theme checked text contrast is at least 4.5:1, dark-theme
checked text contrast is at least 4.5:1, all tests pass, and `git diff --check`
produces no output.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- public/styles.css tests/static-shell.test.js
git commit -m "fix: compact tag selection chips"
```
