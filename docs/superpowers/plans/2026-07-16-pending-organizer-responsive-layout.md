# Pending Organizer Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the oversized single-column pending organizer cards with a responsive ledger that uses three columns on wide desktops, two on medium screens, one on phones, and vertically stacked “收录/移除” actions.

**Architecture:** Keep the existing pending organizer state, API calls, event delegation, conversion form, and confirmation dialog unchanged. Refine only the DOM produced for each pending term and the pending-specific CSS; use semantic buttons with inline SVG icons and term-specific accessible names, then enforce the responsive grid through CSS breakpoints.

**Tech Stack:** Native ES modules, DOM APIs, CSS Grid, Node.js built-in test runner, JSDOM

## Global Constraints

- Preserve the existing cream background, orange primary action, and teal selected state.
- Use a 1200px maximum width for the pending list.
- Use three columns at viewport widths of at least 1100px, two columns from 700px through 1099px, and one column below 700px.
- Render pending terms at 16px on desktop and mobile; wrap complete text only when it exceeds the available content width and never truncate with ellipsis.
- Place “＋ 收录” above “× 移除”; keep both actions directly visible.
- Use 32px button heights on desktop and 44px button heights on phones, with at least 8px between phone actions.
- Keep all existing pending organizer API paths, `data-action` values, mutation serialization, conversion behavior, confirmation behavior, errors, and empty states unchanged.
- Add no framework, icon package, search, sorting, filtering, or batch action.

## File Structure

- Modify `public/pending-view.js`: render the pending ledger rows, inline SVG icons, short visible labels, and term-specific accessible names while preserving existing action hooks.
- Modify `public/styles.css`: style the shared ledger surface, responsive grid, compact term content, and vertical action column.
- Modify `tests/reader-pending-dom.test.js`: verify action order, visible labels, SVG decoration, accessible names, and retained `data-action` contracts.
- Modify `tests/static-shell.test.js`: replace the obsolete 920px single-column expectation with exact width and breakpoint assertions.

---

### Task 1: Render compact, accessible vertical actions

**Files:**
- Modify: `public/pending-view.js:10-15,216-232`
- Test: `tests/reader-pending-dom.test.js:1315-1393`

**Interfaces:**
- Consumes: existing `button(action, text, className)`, pending term objects with `id`, `display_text`, `kind`, and `source_count`, and delegated actions `convert` and `delete-global`.
- Produces: `.pc-pending-row` elements containing `.pc-pending-content` and `.pc-pending-actions`; action buttons keep `data-action="convert"` and `data-action="delete-global"`.

- [ ] **Step 1: Write the failing DOM contract test**

Add a focused test near the existing pending organizer tests in `tests/reader-pending-dom.test.js`:

```js
test('pending organizer renders vertically ordered actions with accessible term labels', async () => {
  const env = installDom('http://local.test/#/articles/pending');
  const cleanup = createPendingView({
    root: env.root,
    api: async path => {
      if (path === '/api/marked-terms') return [{
        id: 't1',
        display_text: 'practice makes perfect',
        normalized_text: 'practice makes perfect',
        kind: 'phrase',
        source_count: 2,
        created_at: 1,
        context_sentence: 'Practice makes perfect.'
      }];
      throw new Error(`unexpected request GET ${path}`);
    }
  });
  try {
    await flush();
    const row = env.root.querySelector('[data-term-id="t1"]');
    const actions = row.querySelector('.pc-pending-actions');
    const buttons = [...actions.querySelectorAll('button')];

    assert.equal(row.classList.contains('pc-card'), false);
    assert.equal(buttons.length, 2);
    assert.deepEqual(buttons.map(node => node.dataset.action), ['convert', 'delete-global']);
    assert.deepEqual(buttons.map(node => node.textContent.trim()), ['收录', '移除']);
    assert.equal(buttons[0].getAttribute('aria-label'), '将 practice makes perfect 收录到记词本');
    assert.equal(buttons[1].getAttribute('aria-label'), '移除 practice makes perfect 的全部标记');
    assert.equal(buttons[0].querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(buttons[1].querySelector('svg').getAttribute('aria-hidden'), 'true');
  } finally {
    cleanup();
    env.restore();
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="pending organizer renders vertically ordered actions" tests/reader-pending-dom.test.js
```

Expected: FAIL because the current rows still have `pc-card`, use `.pc-article-actions`, and show “加入记词本/取消标记” without icons or term-specific accessible names.

- [ ] **Step 3: Add the SVG helper and update pending row markup**

Add this helper below `button()` in `public/pending-view.js`:

```js
function actionIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'plus' ? 'M12 5v14M5 12h14' : 'm6 6 12 12M18 6 6 18');
  svg.append(path);
  return svg;
}
```

Replace the pending row construction inside `render()` with:

```js
const row = element('article', 'pc-pending-row');
row.dataset.termId = term.id;
const content = element('div', 'pc-pending-content');
content.append(element('h2', 'pc-pending-term', term.display_text));
const meta = element('div', 'pc-article-meta');
meta.append(element('span', '', term.kind === 'phrase' ? '短语' : '单词'));
meta.append(element('span', '', `${Number(term.source_count) || 0} 个来源`));
content.append(meta);

const actions = element('div', 'pc-pending-actions');
const collect = button('convert', '收录', 'pc-btn-primary pc-pending-action pc-pending-collect');
collect.setAttribute('aria-label', `将 ${term.display_text} 收录到记词本`);
collect.prepend(actionIcon('plus'));
const remove = button('delete-global', '移除', 'pc-btn-ghost pc-pending-action pc-pending-remove');
remove.setAttribute('aria-label', `移除 ${term.display_text} 的全部标记`);
remove.prepend(actionIcon('remove'));
remove.classList.add('pc-danger');
actions.append(collect, remove);
row.append(content, actions);
list.append(row);
```

- [ ] **Step 4: Run the focused and existing pending organizer tests**

Run:

```powershell
node --test --test-name-pattern="pending organizer|pending conversion|pending cleanup" tests/reader-pending-dom.test.js
```

Expected: PASS. Existing click behavior continues to work because `data-action` values and row `data-term-id` values are unchanged.

- [ ] **Step 5: Commit the DOM change**

```powershell
git add public/pending-view.js tests/reader-pending-dom.test.js
git commit -m "feat: compact pending organizer actions"
```

### Task 2: Implement the responsive ledger layout

**Files:**
- Modify: `public/styles.css:327-329,379-399`
- Test: `tests/static-shell.test.js:27-36`

**Interfaces:**
- Consumes: `.pc-pending-list`, `.pc-pending-row`, `.pc-pending-content`, `.pc-pending-term`, `.pc-pending-actions`, `.pc-pending-action`, `.pc-pending-collect`, and `.pc-pending-remove` from Task 1.
- Produces: one-column default layout, two-column `min-width: 700px` layout, three-column `min-width: 1100px` layout, and phone-sized vertical action targets.

- [ ] **Step 1: Replace the obsolete CSS test with responsive ledger assertions**

Replace `pending organizer stays centered within the desktop content width` in `tests/static-shell.test.js` with:

```js
test('pending organizer uses the responsive three two one column ledger', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const pendingList = css.match(/\.pc-pending-list\s*\{([^}]*)\}/)?.[1];
  assert.ok(pendingList, 'pending list should have a style rule');
  assert.match(pendingList, /display:\s*grid/);
  assert.match(pendingList, /width:\s*100%/);
  assert.match(pendingList, /max-width:\s*1200px/);
  assert.match(pendingList, /grid-template-columns:\s*1fr/);
  assert.match(pendingList, /margin:\s*0\s+auto/);
  assert.match(css, /@media\s*\(min-width:\s*700px\)[\s\S]*?\.pc-pending-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(min-width:\s*1100px\)[\s\S]*?\.pc-pending-list\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.pc-pending-term\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /@media\s*\(max-width:\s*699px\)[\s\S]*?\.pc-pending-action\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media\s*\(max-width:\s*699px\)[\s\S]*?\.pc-pending-actions\s*\{[^}]*gap:\s*8px/);
});
```

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="pending organizer uses the responsive" tests/static-shell.test.js
```

Expected: FAIL because the current CSS still uses a 920px single-column list and has no 700px or 1100px pending breakpoints.

- [ ] **Step 3: Replace pending-specific CSS with the ledger styles**

Replace the existing `.pc-pending-list`, `.pc-pending-row`, and `.pc-pending-term` rules in `public/styles.css` with:

```css
.pc-pending-list {
  width: 100%; max-width: 1200px; margin: 0 auto;
  display: grid; grid-template-columns: 1fr; gap: 1px;
  overflow: hidden; border: 1px solid var(--line); border-radius: 12px;
  background: var(--line);
}
.pc-pending-row {
  min-width: 0; min-height: 96px; padding: 12px 14px;
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px; background: var(--bg-panel);
}
.pc-pending-content { min-width: 0; }
.pc-pending-term {
  margin: 0; color: var(--ink); font-size: 16px; line-height: 1.3;
  overflow-wrap: anywhere;
}
.pc-pending-content .pc-article-meta { margin-top: 5px; }
.pc-pending-actions { width: 76px; display: grid; gap: 6px; }
.pc-pending-action {
  width: 100%; min-height: 32px; padding: 6px 8px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  white-space: nowrap;
}
.pc-pending-action svg {
  width: 13px; height: 13px; flex: 0 0 auto;
  fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}
.pc-pending-remove { color: var(--coral); }
.pc-pending-remove:hover { border-color: var(--coral); color: var(--coral); }
.pc-pending-action:disabled { cursor: not-allowed; opacity: .5; }
.pc-pending-term, .pc-conversion-title { overflow-wrap: anywhere; }
```

Add these pending-specific breakpoints after the base rules and before the existing `max-width: 640px` block:

```css
@media (min-width: 700px) {
  .pc-pending-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 1100px) {
  .pc-pending-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 699px) {
  .pc-pending-row { min-height: 116px; padding: 12px; }
  .pc-pending-actions { width: 82px; gap: 8px; }
  .pc-pending-action { min-height: 44px; }
}
```

Do not reuse `.pc-article-actions` for pending rows. Its existing mobile rule intentionally makes article form actions span rows and must continue serving the article library.

- [ ] **Step 4: Run the focused CSS and DOM tests**

Run:

```powershell
node --test tests/static-shell.test.js tests/reader-pending-dom.test.js
```

Expected: PASS with no failed tests.

- [ ] **Step 5: Run the complete regression suite**

Run:

```powershell
npm test
```

Expected: all tests pass; Node reports zero failures.

- [ ] **Step 6: Verify the real page at target widths**

Run the local Worker:

```powershell
npx wrangler dev --local --port 8787
```

Open `http://localhost:8787/#/articles/pending` and verify:

- 1440px and 1100px: three equal columns inside a centered 1200px maximum-width ledger;
- 1024px and 768px: two columns;
- 390px and 375px: one column, no horizontal scroll, 44px action targets with 8px vertical gap;
- “practice makes perfect” remains on one line when its 16px rendered width fits; longer phrases wrap fully without ellipsis;
- the top button reads “＋ 收录”, the bottom button reads “× 移除”, and both actions still complete their existing flows;
- dark and light themes retain readable text, separators, focus rings, hover states, and disabled states.

- [ ] **Step 7: Commit the responsive styles**

```powershell
git add public/styles.css tests/static-shell.test.js
git commit -m "feat: add responsive pending ledger"
```
