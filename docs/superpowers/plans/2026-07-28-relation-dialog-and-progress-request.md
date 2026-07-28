# Relation Dialog and Progress Request Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the relation dialog and card action alignment while eliminating duplicate unchanged reader position requests.

**Architecture:** Keep the existing vanilla DOM components and APIs. Restructure only the relation form markup needed for reliable layout hooks, position the existing card action group relative to the card, and add a reader-local snapshot comparison before position items enter the existing persistent progress queue.

**Tech Stack:** Vanilla JavaScript ES modules, CSS, Node.js built-in test runner, JSDOM-based DOM tests.

## Global Constraints

- Keep all existing relation API paths, fields, copy, mutations, focus management, and error recovery behavior unchanged.
- Keep edit and more actions at `44×44px`, separated by `8px`, with a `96px` reserved title column.
- Keep the 15-second reader timer and all event progress submissions unchanged.
- Deduplicate only position snapshots whose article ID, exact scroll ratio, and aloud sentence index are all unchanged.
- Do not modify backend interfaces, database schema, queue persistence format, or statistics semantics.
- Preserve desktop and mobile layouts without horizontal overflow.

---

### Task 1: Relation dialog visual hierarchy and control sizing

**Files:**
- Modify: `public/words-view.js:208-251`
- Modify: `public/styles.css:479-528`
- Modify: `public/styles.css:579-590`
- Test: `tests/ui-dom.test.js:386-443`
- Test: `tests/static-shell.test.js:103-128`

**Interfaces:**
- Consumes: existing `mountRelationDialog({ host, word, api, trigger })`, `data-role="relation-form"`, and relation actions.
- Produces: stable layout hooks `.pc-relation-section`, `.pc-relation-search-field`, `.pc-relation-pair`, `.pc-relation-note`, `.pc-relation-form-actions`, and `.pc-relation-delete`.

- [ ] **Step 1: Write the failing DOM structure test**

Add these assertions after the relation dialog finishes loading in `word relations open in a modal and update without stretching the card`:

```js
const sections = dialog.querySelectorAll('.pc-relation-section');
assert.equal(sections.length, 2);
assert.ok(dialog.querySelector('.pc-relation-search-field input[name="targetKeyword"]'));
assert.ok(dialog.querySelector('.pc-relation-search-field [data-action="search-relation-targets"]'));
assert.equal(dialog.querySelectorAll('.pc-relation-pair label').length, 2);
assert.ok(dialog.querySelector('.pc-relation-note input[name="note"]'));
assert.ok(dialog.querySelector('.pc-relation-form-actions .pc-btn-primary'));
assert.ok(dialog.querySelector('.pc-relation-delete[data-action="delete-relation"]'));
```

- [ ] **Step 2: Write the failing CSS contract test**

Extend `word card actions and relation dialog stay responsive` in `tests/static-shell.test.js`:

```js
const relationSection = css.match(/\.pc-relation-section\s*\{([^}]*)\}/)?.[1];
const relationSearch = css.match(/\.pc-relation-search-field\s*\{([^}]*)\}/)?.[1];
const relationPair = css.match(/\.pc-relation-pair\s*\{([^}]*)\}/)?.[1];
const relationActions = css.match(/\.pc-relation-form-actions\s*\{([^}]*)\}/)?.[1];
const relationSearchButton = css.match(/\.pc-relation-search-button\s*\{([^}]*)\}/)?.[1];

assert.ok(relationSection);
assert.ok(relationSearch);
assert.ok(relationPair);
assert.ok(relationActions);
assert.ok(relationSearchButton);
assert.match(relationSection, /border:\s*1px\s+solid\s+var\(--line\)/);
assert.match(relationSearch, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+96px/);
assert.match(relationPair, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(relationSearchButton, /height:\s*44px/);
assert.match(relationActions, /justify-content:\s*flex-end/);
assert.match(css, /\.pc-relation-form-actions \.pc-btn-primary\s*\{[^}]*height:\s*44px/);
assert.match(css, /\.pc-relation-delete\s*\{[^}]*min-height:\s*36px/);
assert.match(
  css,
  /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-relation-search-field,\s*\.pc-relation-pair\s*\{[^}]*grid-template-columns:\s*1fr/
);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="word relations open|word card actions" tests/ui-dom.test.js tests/static-shell.test.js
```

Expected: FAIL because the new relation layout hooks and sizing rules do not exist.

- [ ] **Step 4: Restructure the relation dialog markup**

Change the rendered sections and form in `public/words-view.js` to:

```js
<section class="pc-relation-section pc-relation-list" aria-label="已有关系">
  <h3>已有关系</h3>${relationRows()}
</section>
<section class="pc-relation-section pc-relation-add">
  <h3>添加关系</h3>
  <form data-role="relation-form" data-word-id="${escapeHtml(wordId)}">
    <div class="pc-relation-search-field">
      <label>搜索关联词<input name="targetKeyword" value="${escapeHtml(searchKeyword)}" placeholder="输入单词或释义"></label>
      <button type="button" class="pc-btn-ghost pc-relation-search-button" data-action="search-relation-targets">搜索</button>
    </div>
    <div class="pc-relation-pair">
      <label>关联词<select name="targetWordId">${targetOptions}</select></label>
      <label>关系类型<select name="relationType">
        ${Object.entries(RELATION_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
      </select></label>
    </div>
    <label class="pc-relation-note">备注（可选）<input name="note"></label>
    <div class="pc-relation-form-actions">
      <button class="pc-btn-primary" ${targetOptions ? '' : 'disabled'}>添加关系</button>
    </div>
  </form>
</section>
```

Add `pc-relation-delete` to the existing delete button and use `pc-relation-empty` on the empty-state element. Do not change any `data-action`, field name, or event handler.

- [ ] **Step 5: Implement the desktop and mobile CSS**

Replace the generic two-column form rule with:

```css
.pc-relation-dialog-body { display: grid; gap: 16px; }
.pc-relation-section {
  min-width: 0; padding: 16px; border: 1px solid var(--line);
  border-radius: 10px; background: color-mix(in srgb, var(--bg-panel) 94%, var(--bg));
}
.pc-relation-dialog form { display: grid; gap: 14px; margin-top: 12px; }
.pc-relation-search-field {
  display: grid; grid-template-columns: minmax(0, 1fr) 96px;
  gap: 8px; align-items: end;
}
.pc-relation-pair {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.pc-relation-note { display: block; }
.pc-relation-form-actions { display: flex; justify-content: flex-end; }
.pc-relation-search-button { width: 96px; height: 44px; align-self: end; }
.pc-relation-form-actions .pc-btn-primary { min-width: 120px; height: 44px; }
.pc-relation-delete { min-width: 64px; min-height: 36px; padding: 6px 10px; }
.pc-relation-empty {
  padding: 12px; border: 1px dashed var(--line); border-radius: 8px;
  color: var(--ink-dim); text-align: center;
}
```

In the existing `@media (max-width: 640px)` block, replace the relation form collapse selector with:

```css
.pc-relation-search-field, .pc-relation-pair { grid-template-columns: 1fr; }
.pc-relation-search-button,
.pc-relation-form-actions .pc-btn-primary { width: 100%; }
.pc-relation-form-actions { display: block; }
.pc-relation-section { padding: 14px; }
.pc-relation-row { grid-template-columns: 1fr auto; }
```

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="word relations open|word card actions" tests/ui-dom.test.js tests/static-shell.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add public/words-view.js public/styles.css tests/ui-dom.test.js tests/static-shell.test.js
git commit -m "style: refine relation dialog layout"
```

### Task 2: Flush card actions to the top-right edges

**Files:**
- Modify: `public/styles.css:104-132`
- Test: `tests/static-shell.test.js:103-128`

**Interfaces:**
- Consumes: existing `.pc-card`, `.pc-card-top`, `.pc-card-top-actions`, and two `.pc-card-icon-button` elements.
- Produces: an absolutely positioned 96px action group while preserving the title reserve and existing menu anchor.

- [ ] **Step 1: Write the failing CSS contract test**

Add to `word card actions and relation dialog stay responsive`:

```js
assert.match(cardActions, /position:\s*absolute/);
assert.match(cardActions, /top:\s*0/);
assert.match(cardActions, /right:\s*0/);
assert.match(
  css,
  /\.pc-card-top-actions\s*>\s*\.pc-card-icon-button:last-of-type\s*\{[^}]*border-radius:\s*0\s+11px\s+0\s+7px/
);
```

- [ ] **Step 2: Run the focused static test and verify RED**

Run:

```powershell
node --test --test-name-pattern="word card actions" tests/static-shell.test.js
```

Expected: FAIL because `.pc-card-top-actions` is still relatively positioned inside card padding.

- [ ] **Step 3: Implement the edge-aligned action group**

Update `public/styles.css`:

```css
.pc-card-top-actions {
  position: absolute; top: 0; right: 0;
  display: grid; grid-template-columns: repeat(2, 44px);
  gap: 8px; width: 96px;
}
.pc-card-top-actions > .pc-card-icon-button:last-of-type {
  border-radius: 0 11px 0 7px;
}
```

Keep `.pc-card-top` at `grid-template-columns: minmax(0, 1fr) 96px` so the title cannot render below the actions. Keep `.pc-card-action-menu` positioned relative to the action group.

- [ ] **Step 4: Run the focused static test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="word card actions" tests/static-shell.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/styles.css tests/static-shell.test.js
git commit -m "style: align word card actions to edges"
```

### Task 3: Deduplicate unchanged reader position snapshots

**Files:**
- Modify: `public/reader-view.js:120-238`
- Test: `tests/reader-pending-dom.test.js:2335-2420`

**Interfaces:**
- Consumes: existing `progressQueue.submit(item)` and reader-local `articleId`, `currentPositionRatio()`, and aloud index state.
- Produces: reader-local `lastQueuedPosition` comparison; no public API or queue format changes.

- [ ] **Step 1: Write the failing reader regression test**

Add:

```js
test('reader skips unchanged position snapshots while preserving active-time events', async () => {
  const env = installDom();
  let now = 0;
  let scrollY = 0;
  const submitted = [];
  const intervals = [];
  const speech = createReaderSpeechFake();
  Object.defineProperty(env.window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(env.window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(env.window.document.documentElement, 'scrollHeight', {
    configurable: true, get: () => 2000
  });
  Object.defineProperty(env.window.document, 'visibilityState', {
    configurable: true, value: 'visible'
  });
  env.window.scrollTo = ({ top }) => { scrollY = top; };
  const cleanup = createReaderView({
    root: env.root,
    api: async path => {
      if (path === '/api/articles/a1') {
        return articleDetail({ progress: { last_position_ratio: 0 } });
      }
      throw new Error(`unexpected request ${path}`);
    },
    articleId: 'a1',
    navigate() {},
    speech: speech.controller,
    progressQueue: { submit: async item => { submitted.push(item); return true; } },
    progressRuntime: {
      now: () => now,
      setInterval: callback => { intervals.push(callback); return callback; },
      clearInterval() {},
      requestAnimationFrame: callback => callback()
    }
  });
  try {
    await flush();
    env.window.dispatchEvent(new env.window.Event('scroll'));
    now = 5_000;
    intervals[0]();
    now = 10_000;
    intervals[0]();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 1);
    assert.equal(submitted.filter(item => item.event?.type === 'active_ms').length, 2);

    Object.defineProperty(env.window.document, 'visibilityState', {
      configurable: true, value: 'hidden'
    });
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    Object.defineProperty(env.window.document, 'visibilityState', {
      configurable: true, value: 'visible'
    });
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    assert.equal(submitted.filter(item => item.kind === 'position').length, 1);

    scrollY = 500;
    intervals[0]();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 2);

    speech.emit({ state: 'paused', currentIndex: 1 });
    await Promise.resolve();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 3);

    cleanup();
    assert.equal(submitted.filter(item => item.kind === 'position').length, 3);
  } finally {
    env.restore();
  }
});
```

- [ ] **Step 2: Run the focused reader test and verify RED**

Run:

```powershell
node --test --test-name-pattern="reader skips unchanged position" tests/reader-pending-dom.test.js
```

Expected: FAIL because repeated timers and cleanup currently submit identical position items.

- [ ] **Step 3: Implement exact position snapshot comparison**

Add reader-local state near the other progress state:

```js
let lastQueuedPosition = null;
```

Replace the unconditional position submission at the end of `saveProgress()` with:

```js
const position = {
  kind: 'position',
  articleId,
  lastPositionRatio: currentPositionRatio(),
  lastAloudSentenceIndex: currentAloudIndex
};
const unchanged = lastQueuedPosition
  && lastQueuedPosition.articleId === position.articleId
  && lastQueuedPosition.lastPositionRatio === position.lastPositionRatio
  && lastQueuedPosition.lastAloudSentenceIndex === position.lastAloudSentenceIndex;
if (unchanged) return;
lastQueuedPosition = {
  articleId: position.articleId,
  lastPositionRatio: position.lastPositionRatio,
  lastAloudSentenceIndex: position.lastAloudSentenceIndex
};
submitProgress(position);
```

Do not move the active-time flushing logic below the unchanged check; active-time events must continue to be submitted.

- [ ] **Step 4: Run the focused reader test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="reader skips unchanged position" tests/reader-pending-dom.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the existing reader progress regression group**

Run:

```powershell
node --test --test-name-pattern="progress|reading, time, position|logout unmounts" tests/reader-pending-dom.test.js tests/reading-session.test.js
```

Expected: PASS with no lost event submissions or logout ordering regressions.

- [ ] **Step 6: Commit**

```powershell
git add public/reader-view.js tests/reader-pending-dom.test.js
git commit -m "fix: deduplicate reader position progress"
```

### Task 4: Full verification

**Files:**
- Verify: `public/words-view.js`
- Verify: `public/reader-view.js`
- Verify: `public/styles.css`
- Verify: `tests/ui-dom.test.js`
- Verify: `tests/static-shell.test.js`
- Verify: `tests/reader-pending-dom.test.js`

**Interfaces:**
- Consumes: the three independently committed changes above.
- Produces: a clean, verified feature branch ready for integration.

- [ ] **Step 1: Run the complete test suite**

```powershell
npm.cmd test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run syntax checks**

```powershell
node --check public/words-view.js
node --check public/reader-view.js
```

Expected: both commands exit with code 0 and print no syntax errors.

- [ ] **Step 3: Run diff and repository checks**

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits with code 0; status contains only intentional plan or implementation changes before their final commit, or is empty after all task commits.
