# Progressive Article Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the all-or-nothing full-article translation request with a resumable workflow that renders and saves each completed batch immediately.

**Architecture:** A pure server-side batch planner deterministically groups natural paragraphs. Two normalized D1 tables store translation metadata and paragraph results independently, while a batch endpoint translates one deterministic batch at a time. The reader switches to full mode immediately, requests the first small batch alone, then schedules at most two later batches concurrently and merges each response into the visible article.

**Tech Stack:** Cloudflare Workers, Workers AI (`@cf/zai-org/glm-4.7-flash`), D1/SQLite migrations, browser ES modules, Node test runner, JSDOM.

## Global Constraints

- First batch target: title plus at most 500 Unicode code points of body; an oversized first paragraph remains intact and occupies the batch alone.
- Later batches: natural-paragraph boundaries, target 800–1200 Unicode code points; an oversized paragraph occupies one batch.
- Do not split natural paragraphs.
- The server owns batch construction; clients send only batch index, source hash, rules version, and refresh intent.
- Start later work only after batch 0 completes; later concurrency must never exceed 2.
- Persist and render every successful batch immediately.
- Automatically retry timeout, temporary-unavailable, and format-invalid failures once; do not automatically retry conflict, invalid-input, or quota failures.
- Preserve the existing model and old complete `article_translations` read compatibility.
- Do not add Queue, Workflow, Durable Object, token streaming, or new dependencies.

---

### Task 1: Deterministic article batch planner

**Files:**
- Create: `src/article-translation-batches.js`
- Test: `tests/article-translation-batches.test.js`

**Interfaces:**
- Consumes: paragraph records shaped as `{ index: number, text: string }`.
- Produces: `createArticleTranslationBatches(paragraphs)` returning `{ index, paragraphIndexes, paragraphs }[]`.
- Produces: `ARTICLE_FIRST_BATCH_TARGET = 500`, `ARTICLE_LATER_BATCH_MIN = 800`, and `ARTICLE_LATER_BATCH_MAX = 1200`.

- [ ] **Step 1: Write failing batch-boundary tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_FIRST_BATCH_TARGET,
  ARTICLE_LATER_BATCH_MAX,
  createArticleTranslationBatches
} from '../src/article-translation-batches.js';

test('article translation gives the opening paragraph a small first batch', () => {
  const paragraphs = [
    { index: 0, text: 'a'.repeat(300) },
    { index: 1, text: 'b'.repeat(300) },
    { index: 2, text: 'c'.repeat(500) }
  ];
  const batches = createArticleTranslationBatches(paragraphs);
  assert.equal(ARTICLE_FIRST_BATCH_TARGET, 500);
  assert.deepEqual(batches.map(batch => batch.paragraphIndexes), [[0], [1, 2]]);
});

test('article translation keeps oversized natural paragraphs intact', () => {
  const paragraphs = [
    { index: 0, text: 'a'.repeat(700) },
    { index: 1, text: 'b'.repeat(ARTICLE_LATER_BATCH_MAX + 1) },
    { index: 2, text: 'c'.repeat(100) }
  ];
  assert.deepEqual(
    createArticleTranslationBatches(paragraphs).map(batch => batch.paragraphIndexes),
    [[0], [1], [2]]
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/article-translation-batches.test.js`

Expected: FAIL because `src/article-translation-batches.js` does not exist.

- [ ] **Step 3: Implement the pure planner**

```js
export const ARTICLE_FIRST_BATCH_TARGET = 500;
export const ARTICLE_LATER_BATCH_MIN = 800;
export const ARTICLE_LATER_BATCH_MAX = 1200;

export function createArticleTranslationBatches(paragraphs) {
  const remaining = [...paragraphs];
  const batches = [];
  if (remaining.length) batches.push(takeBatch(remaining, ARTICLE_FIRST_BATCH_TARGET));
  while (remaining.length) batches.push(takeBatch(remaining, ARTICLE_LATER_BATCH_MAX));
  return batches.map((items, index) => ({
    index,
    paragraphIndexes: items.map(item => item.index),
    paragraphs: items
  }));
}

function takeBatch(remaining, limit) {
  const batch = [];
  let length = 0;
  while (remaining.length) {
    const nextLength = Array.from(remaining[0].text).length;
    if (batch.length && length + nextLength > limit) break;
    batch.push(remaining.shift());
    length += nextLength;
    if (nextLength > limit) break;
  }
  return batch;
}
```

- [ ] **Step 4: Run the planner tests and verify GREEN**

Run: `node --test tests/article-translation-batches.test.js`

Expected: 2 tests pass.

- [ ] **Step 5: Commit the planner**

```powershell
git add src/article-translation-batches.js tests/article-translation-batches.test.js
git commit -m "Add progressive translation batch planner"
```

### Task 2: Progressive translation persistence schema

**Files:**
- Create: `migrations/0012_progressive_article_translations.sql`
- Modify: `tests/translations-api.test.js`

**Interfaces:**
- Produces table `article_translation_progress` keyed by `article_id`.
- Produces table `article_translation_paragraphs` keyed by article, user, source hash, rules version, and paragraph index.

- [ ] **Step 1: Add a failing migration test**

```js
test('progressive article translation migration stores metadata and paragraphs independently', () => {
  const DB = createSqliteDb();
  try {
    assert.deepEqual(DB.all('PRAGMA table_info(article_translation_progress)').map(row => row.name), [
      'article_id', 'user_id', 'source_hash', 'rules_version', 'title_zh',
      'model', 'created_at', 'updated_at'
    ]);
    assert.deepEqual(DB.all('PRAGMA table_info(article_translation_paragraphs)').map(row => row.name), [
      'article_id', 'user_id', 'source_hash', 'rules_version', 'paragraph_index',
      'translation_zh', 'model', 'created_at', 'updated_at'
    ]);
  } finally {
    DB.close();
  }
});
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `node --test --test-name-pattern="progressive article translation migration" tests/translations-api.test.js`

Expected: FAIL because both tables are absent.

- [ ] **Step 3: Add migration 0012**

```sql
CREATE TABLE IF NOT EXISTS article_translation_progress (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  title_zh TEXT,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS article_translation_paragraphs (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  paragraph_index INTEGER NOT NULL,
  translation_zh TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, user_id, source_hash, rules_version, paragraph_index)
);

CREATE INDEX IF NOT EXISTS idx_article_translation_paragraphs_current
  ON article_translation_paragraphs(article_id, user_id, source_hash, rules_version);
```

- [ ] **Step 4: Run the migration test and verify GREEN**

Run: `node --test --test-name-pattern="progressive article translation migration" tests/translations-api.test.js`

Expected: 1 matching test passes.

- [ ] **Step 5: Commit the schema**

```powershell
git add migrations/0012_progressive_article_translations.sql tests/translations-api.test.js
git commit -m "Add progressive translation storage"
```

### Task 3: Query partial and complete translation status

**Files:**
- Create: `src/article-translation-progress.js`
- Modify: `src/translation-api.js`
- Modify: `tests/translations-api.test.js`

**Interfaces:**
- Produces `ARTICLE_TRANSLATION_RULES_VERSION = 'article-v2-progressive'`.
- Produces `loadArticleTranslationState(DB, article, userId)` returning the public `missing|partial|fresh` response.
- Consumes `createArticleTranslationBatches()` from Task 1.

- [ ] **Step 1: Add failing GET-state tests**

```js
test('article translation GET exposes deterministic missing and partial batch state', async t => {
  const DB = seededArticleDb('First paragraph.\n\nSecond paragraph.');
  t.after(() => DB.close());
  const missing = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), { AUTH_SECRET: SECRET, DB });
  const state = await missing.json();
  assert.equal(state.status, 'missing');
  assert.equal(state.rulesVersion, 'article-v2-progressive');
  assert.equal(state.completedBatches, 0);
  assert.ok(state.sourceHash);
  assert.deepEqual(state.paragraphs, []);
});
```

Add this partial-state test after obtaining `sourceHash` from the missing response:

```js
DB.prepare(`INSERT INTO article_translation_progress
  (article_id, user_id, source_hash, rules_version, title_zh, model, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind('a1', 'u1', state.sourceHash, state.rulesVersion, '标题', 'model', 1, 1).run();
DB.prepare(`INSERT INTO article_translation_paragraphs
  (article_id, user_id, source_hash, rules_version, paragraph_index,
   translation_zh, model, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind('a1', 'u1', state.sourceHash, state.rulesVersion, 0, '第一段。', 'model', 1, 1).run();
const partial = await (await worker.fetch(await authenticatedRequest(
  '/api/articles/a1/translation', 'GET'
), { AUTH_SECRET: SECRET, DB })).json();
assert.equal(partial.status, 'partial');
assert.deepEqual(partial.paragraphs, [{ index: 0, translation: '第一段。' }]);
assert.deepEqual(partial.batches.map(batch => batch.completed), [true, false]);
```

- [ ] **Step 2: Run the focused GET tests and verify RED**

Run: `node --test --test-name-pattern="article translation GET exposes" tests/translations-api.test.js`

Expected: FAIL because GET still returns only `{ status: 'missing' }`.

- [ ] **Step 3: Implement normalized state loading**

Create helpers with these exact signatures:

```js
export const ARTICLE_TRANSLATION_RULES_VERSION = 'article-v2-progressive';

export async function loadArticleTranslationState(DB, article, userId) {
  const sourceHash = await articleSourceHash(article.title, article.body);
  const paragraphs = splitArticleParagraphs(article.body).paragraphs
    .map(({ index, text }) => ({ index, text }));
  const batches = createArticleTranslationBatches(paragraphs);
  // Read current metadata and paragraph rows, derive completed batch flags,
  // and return missing, partial, or fresh without returning stale hashes.
}
```

Move/export `articleSourceHash(title, body)` from `src/translation-api.js` into this focused module. In `getArticleTranslation`, prefer progressive state when current progressive rows exist; otherwise retain the old `article_translations` fresh-result fallback.

- [ ] **Step 4: Run translation API tests and verify GREEN**

Run: `node --test tests/translations-api.test.js`

Expected: all translation API tests pass, including legacy complete-result reads.

- [ ] **Step 5: Commit state loading**

```powershell
git add src/article-translation-progress.js src/translation-api.js tests/translations-api.test.js
git commit -m "Expose partial article translation state"
```

### Task 4: Translate and persist one deterministic batch

**Files:**
- Modify: `src/article-translation-progress.js`
- Modify: `src/translation-api.js`
- Modify: `src/index.js`
- Modify: `tests/translations-api.test.js`

**Interfaces:**
- Adds `PUT /api/articles/:articleId/translation/batches/:batchIndex`.
- Request: `{ sourceHash: string, rulesVersion: string, refresh?: boolean }`.
- Response: current state plus `completedBatch: number` and the saved batch paragraphs.
- Produces stable `409 TRANSLATION_RULES_CHANGED` and preserves `409 TRANSLATION_SOURCE_CHANGED`.

- [ ] **Step 1: Add failing endpoint tests**

Add the successful batch test:

```js
const state = await (await worker.fetch(await authenticatedRequest(
  '/api/articles/a1/translation', 'GET'
), env)).json();
const translated = await worker.fetch(await authenticatedRequest(
  '/api/articles/a1/translation/batches/0', 'PUT', {
    sourceHash: state.sourceHash,
    rulesVersion: state.rulesVersion
  }
), env);
assert.equal(translated.status, 200);
assert.equal((await translated.json()).completedBatch, 0);
assert.equal(DB.all('SELECT * FROM article_translation_paragraphs').length, 1);
```

Add these separate assertions in named tests using the same seeded state helper:

```js
// Cached duplicate.
await requestBatch(0, { sourceHash: state.sourceHash, rulesVersion: state.rulesVersion });
await requestBatch(0, { sourceHash: state.sourceHash, rulesVersion: state.rulesVersion });
assert.equal(aiCalls, 1);

// Forced refresh.
await requestBatch(0, {
  sourceHash: state.sourceHash, rulesVersion: state.rulesVersion, refresh: true
});
assert.equal(aiCalls, 2);

// Stable validation failures.
assert.equal((await invalidBatch.json()).code, 'INVALID_TRANSLATION_BATCH');
assert.equal((await rulesConflict.json()).code, 'TRANSLATION_RULES_CHANGED');

// Source changed during AI: no new paragraph is saved.
assert.equal(sourceChanged.status, 409);
assert.equal((await sourceChanged.json()).code, 'TRANSLATION_SOURCE_CHANGED');
assert.equal(DB.all('SELECT * FROM article_translation_paragraphs').length, 0);

// Reverse completion retains both rows.
assert.deepEqual(
  DB.all('SELECT paragraph_index FROM article_translation_paragraphs ORDER BY paragraph_index')
    .map(row => row.paragraph_index),
  [0, 1]
);
```

Define this wrapper inside each test and do not share mutable DB state between tests:

```js
const requestBatch = async (index, body) => worker.fetch(
  await authenticatedRequest(
    `/api/articles/a1/translation/batches/${index}`, 'PUT', body
  ),
  env
);
```

- [ ] **Step 2: Run the batch endpoint tests and verify RED**

Run: `node --test --test-name-pattern="article translation batch" tests/translations-api.test.js`

Expected: FAIL with `NOT_FOUND` for the new route.

- [ ] **Step 3: Route and validate the batch request**

In `src/index.js`, route the batch path before the existing translation path:

```js
if (/^\/api\/articles\/[a-zA-Z0-9-]+\/translation\/batches\/\d+$/.test(path)) {
  return await handleTranslationApi(request, env, path, userId);
}
```

In `handleTranslationApi`, parse article and batch index, require PUT, read the object body, verify `sourceHash` and `rulesVersion`, recompute current state, and reject mismatches before calling AI.

- [ ] **Step 4: Generate and atomically save the batch**

Use the existing strict article JSON parser against only the expected batch paragraphs. Before saving, reload article title/body and verify the source hash. Persist with one `DB.batch()` containing:

```js
[
  DB.prepare(`DELETE FROM article_translation_paragraphs
              WHERE article_id = ? AND user_id = ? AND source_hash <> ?`)
    .bind(articleId, userId, sourceHash),
  DB.prepare(`INSERT INTO article_translation_progress
              (article_id, user_id, source_hash, rules_version, title_zh,
               model, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(article_id) DO UPDATE SET
                user_id = excluded.user_id,
                source_hash = excluded.source_hash,
                rules_version = excluded.rules_version,
                title_zh = COALESCE(excluded.title_zh, article_translation_progress.title_zh),
                model = excluded.model,
                updated_at = excluded.updated_at`)
    .bind(articleId, userId, sourceHash, ARTICLE_TRANSLATION_RULES_VERSION,
      parsed.titleTranslation || null, TRANSLATION_MODEL, now, now),
  ...parsed.paragraphs.map(paragraph => DB.prepare(`
    INSERT INTO article_translation_paragraphs
      (article_id, user_id, source_hash, rules_version, paragraph_index,
       translation_zh, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(article_id, user_id, source_hash, rules_version, paragraph_index)
    DO UPDATE SET translation_zh = excluded.translation_zh,
                  model = excluded.model,
                  updated_at = excluded.updated_at
  `).bind(articleId, userId, sourceHash, ARTICLE_TRANSLATION_RULES_VERSION,
    paragraph.index, paragraph.translation, TRANSLATION_MODEL, now, now))
]
```

Return `loadArticleTranslationState()` after the write. Skip AI and return state when all paragraphs in the requested batch already exist and `refresh !== true`.

- [ ] **Step 5: Run all server translation tests and verify GREEN**

Run: `node --test tests/article-translation-batches.test.js tests/translations-api.test.js`

Expected: all tests pass.

- [ ] **Step 6: Commit the batch API**

```powershell
git add src/article-translation-progress.js src/translation-api.js src/index.js tests/translations-api.test.js
git commit -m "Add resumable article translation batches"
```

### Task 5: Render partial article translations immediately

**Files:**
- Modify: `public/reader-view.js`
- Modify: `tests/reader-pending-dom.test.js`

**Interfaces:**
- `articleTranslation` may contain `status: 'partial'` or `status: 'fresh'`.
- Adds visible roles `article-translation-progress` and `paragraph-translation-pending`.
- Produces `mergeArticleTranslationState(result)` and `syncArticleTranslationView()` local helpers.

- [ ] **Step 1: Write failing immediate-render tests**

Create a test where GET returns a partial state with paragraph 0 completed and paragraph 1 pending. Assert:

```js
click(env.window, env.root.querySelector('[data-action="translation-menu"]'));
click(env.window, env.root.querySelector(
  '[data-action="translation-mode"][data-mode="full"]'
));
assert.equal(env.root.querySelector('[data-role="paragraph-translation"]').textContent, '第一段。');
assert.equal(env.root.querySelector('[data-role="paragraph-translation-pending"]').dataset.paragraphIndex, '1');
assert.equal(env.root.querySelector('[data-role="article-translation-progress"]').textContent, '已翻译 1/2 批');
```

Also assert that selecting full mode does not wait for a deferred batch request before rendering the full-mode body.

- [ ] **Step 2: Run the focused DOM tests and verify RED**

Run: `node --test --test-name-pattern="partial article translation|full mode immediately" tests/reader-pending-dom.test.js`

Expected: FAIL because only `fresh` results are retained and full mode waits for translation.

- [ ] **Step 3: Accept partial state and render placeholders**

Change `loadArticleTranslation()` to retain `partial` and `fresh`. Change `setTranslationMode('full')` to set and render the mode immediately, then start translation asynchronously. In `renderBody`, append either the saved translation or:

```js
const pending = element('div', 'pc-reader-translation pc-reader-translation-pending', '等待翻译');
pending.dataset.role = 'paragraph-translation-pending';
pending.dataset.paragraphIndex = String(paragraph.index);
```

Render a progress node from `completedBatches` and `totalBatches` whenever full mode is partial.

- [ ] **Step 4: Run the focused DOM tests and verify GREEN**

Run: `node --test --test-name-pattern="partial article translation|full mode immediately" tests/reader-pending-dom.test.js`

Expected: matching tests pass.

- [ ] **Step 5: Commit partial rendering**

```powershell
git add public/reader-view.js tests/reader-pending-dom.test.js
git commit -m "Render partial article translations"
```

### Task 6: First-batch priority and two-worker scheduler

**Files:**
- Create: `public/lib/article-translation-scheduler.js`
- Modify: `public/reader-view.js`
- Create: `tests/article-translation-scheduler.test.js`
- Modify: `tests/reader-pending-dom.test.js`

**Interfaces:**
- Produces `createArticleTranslationScheduler({ requestBatch, onBatch, onError })`.
- Scheduler methods: `start(state, { refresh?: boolean })`, `suspend()`, `invalidate()`.
- `requestBatch(batch, state, refresh)` returns the updated server state.

- [ ] **Step 1: Write failing scheduler tests**

Use deferred promises to assert batch 0 is the only initial request. After it resolves, assert batches 1 and 2 start, batch 3 waits until either finishes, and observed concurrency never exceeds 2. Add tests for:

```js
assert.deepEqual(startedBeforeFirstResolution, [0]);
assert.equal(maxConcurrent, 2);
assert.deepEqual(renderedBatches, [0, 2, 1, 3]);
```

Also prove `suspend()` prevents new work while allowing in-flight promises to call `onBatch`, and `start()` resumes only missing batches.

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `node --test tests/article-translation-scheduler.test.js`

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement the scheduler**

Maintain one generation number, an active count, a queue of incomplete batches, and a suspended flag. `start()` must enqueue batch 0 alone when incomplete. Only after its success may `pump()` start later batches until `active === 2`. Each successful response calls `onBatch(result)` immediately and then pumps again.

- [ ] **Step 4: Integrate the scheduler with the reader**

Create one scheduler per reader view. Its `requestBatch` calls:

```js
api(`/api/articles/${encodeURIComponent(articleId)}/translation/batches/${batch.index}`, {
  method: 'PUT',
  body: JSON.stringify({
    sourceHash: state.sourceHash,
    rulesVersion: state.rulesVersion,
    refresh
  })
})
```

`onBatch` replaces `articleTranslation`, calls `syncArticleTranslationView()`, and updates the toolbar. Leaving full mode calls `suspend()`; cleanup calls `invalidate()`.

- [ ] **Step 5: Run scheduler and reader tests and verify GREEN**

Run: `node --test tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js`

Expected: all scheduler and reader DOM tests pass.

- [ ] **Step 6: Commit progressive scheduling**

```powershell
git add public/lib/article-translation-scheduler.js public/reader-view.js tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js
git commit -m "Schedule progressive article translation"
```

### Task 7: Retry, quota stop, refresh, and accessible status styling

**Files:**
- Modify: `public/lib/article-translation-scheduler.js`
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Modify: `tests/article-translation-scheduler.test.js`
- Modify: `tests/reader-pending-dom.test.js`
- Modify: `tests/static-shell.test.js`

**Interfaces:**
- Retryable codes: `TRANSLATION_TIMEOUT`, `TRANSLATION_UNAVAILABLE`, `TRANSLATION_FORMAT_INVALID`.
- Terminal scheduler code: `TRANSLATION_DAILY_LIMIT` stops all queued work.
- Manual continue restarts failed/missing batches; refresh calls `start(state, { refresh: true })`.

- [ ] **Step 1: Write failing retry and stop tests**

Assert a retryable batch is requested exactly twice, a second failure becomes visible, and quota failure starts no further batches. Assert refresh passes `refresh: true` for every selected batch and retains old translations until replacements arrive.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern="translation scheduler retries|translation quota|refreshes progressive" tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js`

Expected: FAIL because retry classification and manual continuation are absent.

- [ ] **Step 3: Implement bounded retry and user actions**

Use a per-batch attempt map. Retry only the three retryable codes and only while attempts are below 2. On quota, mark the scheduler stopped and call `onError(error, { terminal: true })`. Add reader actions `continue-article-translation` and reuse `translate-article` for forced refresh.

- [ ] **Step 4: Add quiet pending/progress styles**

```css
.pc-article-translation-progress {
  margin: 0 0 1em;
  color: var(--ink-dim);
  font-size: .8em;
}
.pc-reader-translation-pending {
  min-height: 2.5em;
  color: var(--ink-dim);
  opacity: .72;
}
```

Add static CSS assertions for both selectors and ensure the progress node uses `role="status"` with `aria-live="polite"`.

- [ ] **Step 5: Run affected tests and verify GREEN**

Run: `node --test tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js tests/static-shell.test.js`

Expected: all affected tests pass.

- [ ] **Step 6: Commit recovery and styling**

```powershell
git add public/lib/article-translation-scheduler.js public/reader-view.js public/styles.css tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "Handle progressive translation recovery"
```

### Task 8: End-to-end compatibility and completion verification

**Files:**
- Modify: `public/sw.js`
- Modify: `tests/static-shell.test.js`

**Interfaces:**
- The application shell must precache `/lib/article-translation-scheduler.js`.
- Final GET state must remain consumable as the existing `{ status: 'fresh', titleZh, paragraphs, model, updatedAt }` shape plus additive progress metadata.

- [ ] **Step 1: Add the new browser module to the service-worker shell**

Add `'/lib/article-translation-scheduler.js'` to `SHELL_ASSETS` and assert its presence in `tests/static-shell.test.js`.

- [ ] **Step 2: Run the complete test suite**

Run: `npm.cmd run test:all`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run the GitHub Actions Node version**

Run: `npx.cmd --yes node@22 --test tests/**/*.test.js`

Expected: all tests pass with zero failures under Node 22.

- [ ] **Step 4: Check repository hygiene**

Run: `git diff --check`

Expected: exit code 0 and no whitespace errors.

- [ ] **Step 5: Commit final integration changes**

```powershell
git add public/sw.js tests/static-shell.test.js
git commit -m "Complete progressive article translation"
```
