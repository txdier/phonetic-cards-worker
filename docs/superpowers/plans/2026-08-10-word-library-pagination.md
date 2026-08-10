# Word Library Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current and total page counts in the word library and add conditional first-page and last-page navigation.

**Architecture:** Keep pagination state inside the existing `createWordsView` closure. Derive the total page count from the API's existing `total` and `pageSize` values, render navigation from that derived value, and reuse `loadLibrary()` for all page changes.

**Tech Stack:** Browser ES modules, HTML template strings, CSS flexbox, Node.js test runner, JSDOM

## Global Constraints

- Do not change the word-library API contract.
- Render pagination in this order: `首页　上一页　第 N / 共 M 页　下一页　尾页` when all controls are eligible.
- Compute total pages with `Math.max(1, Math.ceil(total / pageSize))`.
- Show “首页” only when `currentPage > 1`.
- Show “尾页” only when `totalPages > 2 && currentPage < totalPages`.
- Preserve the existing previous-page and next-page controls and their disabled states.
- Allow the pagination controls to wrap on narrow screens.

---

### Task 1: Word library pagination rendering and navigation

**Files:**
- Modify: `tests/ui-dom.test.js`
- Modify: `public/words-view.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: word-list API responses shaped as `{ words, total, page, pageSize }` and the existing `loadLibrary(): Promise<void>` closure.
- Produces: DOM actions `page-first` and `page-last`; pagination status text `第 N / 共 M 页`.

- [ ] **Step 1: Write failing DOM tests for visibility, status, and navigation**

Add tests to `tests/ui-dom.test.js` that mount the real words view against a stateful fake API:

```js
test('word library pagination shows page totals and conditionally renders boundary buttons', async () => {
  const env = installDom();
  let requestedPage = 1;
  const cleanup = createWordsView({
    root: env.root,
    api: async path => {
      if (path === '/api/tags') return { tags: [] };
      if (path.startsWith('/api/words')) {
        const url = new URL(path, 'http://local.test');
        requestedPage = Number(url.searchParams.get('page') || 1);
        return { words: [], total: 72, page: requestedPage, pageSize: 24 };
      }
      throw new Error(`unexpected request GET ${path}`);
    },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    assert.match(env.root.querySelector('.pc-pagination').textContent, /第 1 \/ 共 3 页/);
    assert.equal(env.root.querySelector('[data-action="page-first"]'), null);
    assert.ok(env.root.querySelector('[data-action="page-last"]'));

    click(env.window, env.root.querySelector('[data-action="page-next"]'));
    await flush();
    assert.equal(requestedPage, 2);
    assert.ok(env.root.querySelector('[data-action="page-first"]'));
    assert.ok(env.root.querySelector('[data-action="page-last"]'));

    click(env.window, env.root.querySelector('[data-action="page-last"]'));
    await flush();
    assert.equal(requestedPage, 3);
    assert.ok(env.root.querySelector('[data-action="page-first"]'));
    assert.equal(env.root.querySelector('[data-action="page-last"]'), null);
    assert.equal(env.root.querySelector('[data-action="page-next"]').disabled, true);

    click(env.window, env.root.querySelector('[data-action="page-first"]'));
    await flush();
    assert.equal(requestedPage, 1);
  } finally {
    cleanup();
    env.restore();
  }
});

test('word library pagination omits the last-page button when there are at most two pages', async () => {
  const env = installDom();
  const cleanup = createWordsView({
    root: env.root,
    api: async path => path === '/api/tags'
      ? { tags: [] }
      : { words: [], total: 48, page: 1, pageSize: 24 },
    speech: { isSupported: true, speakOnce() {}, stop() {} }
  });
  try {
    await flush();
    assert.match(env.root.querySelector('.pc-pagination').textContent, /第 1 \/ 共 2 页/);
    assert.equal(env.root.querySelector('[data-action="page-last"]'), null);
  } finally {
    cleanup();
    env.restore();
  }
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="word library pagination" tests/ui-dom.test.js
```

Expected: FAIL because the status still reads `第 1 页` and `page-last` is not rendered.

- [ ] **Step 3: Implement the minimal pagination markup and click actions**

Update `libraryBody()` in `public/words-view.js`:

```js
const totalPages = Math.max(1, Math.ceil(total / pageSize));
```

Place that declaration immediately after the existing `editing` declaration. Replace only the existing `.pc-pagination` fragment with:

```js
<div class="pc-pagination">
  ${currentPage > 1 ? '<button data-action="page-first">首页</button>' : ''}
  <button data-action="page-prev" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
  <span>第 ${currentPage} / 共 ${totalPages} 页</span>
  <button data-action="page-next" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
  ${totalPages > 2 && currentPage < totalPages ? '<button data-action="page-last">尾页</button>' : ''}
</div>
```

Keep the existing header, filters, form, grid, and empty-state markup unchanged. Add the actions beside the existing previous/next handlers:

```js
if (action === 'page-first' && currentPage > 1) { currentPage = 1; loadLibrary(); }
if (action === 'page-prev' && currentPage > 1) { currentPage -= 1; loadLibrary(); }
if (action === 'page-next' && currentPage < Math.max(1, Math.ceil(total / pageSize))) {
  currentPage += 1;
  loadLibrary();
}
if (action === 'page-last') {
  currentPage = Math.max(1, Math.ceil(total / pageSize));
  loadLibrary();
}
```

Update `public/styles.css` so added controls remain inside narrow viewports:

```css
.pc-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 14px;
  margin: 20px 0;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="word library pagination" tests/ui-dom.test.js
```

Expected: both pagination tests PASS.

- [ ] **Step 5: Run the complete test suite**

Run:

```powershell
npm test
```

Expected: all tests PASS with no errors or warnings caused by this change.

- [ ] **Step 6: Review the diff and commit the implementation**

Run:

```powershell
git diff --check
git diff -- tests/ui-dom.test.js public/words-view.js public/styles.css
git add -- tests/ui-dom.test.js public/words-view.js public/styles.css
git commit -m "feat: improve word library pagination"
```

Expected: the diff contains only the tested pagination behavior and wrapping style, and the commit succeeds.
