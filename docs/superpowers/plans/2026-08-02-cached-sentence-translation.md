# Cached Sentence Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add context-aware, persistent single-sentence translation with stable inline slots, and replace the standalone full-translation controls with a toolbar translation panel.

**Architecture:** A new user-scoped D1 cache stores strict sentence translations keyed by normalized sentence, complete paragraph context, model, and rules version. The Worker derives all source text from the owned article and exposes one GET/POST sentence-translation endpoint; the reader uses a persisted display mode to render either original text, stable sentence slots, or the existing paragraph-level translation layer. Existing full-article and selection translation behavior remains compatible.

**Tech Stack:** Cloudflare Worker JavaScript, Workers AI `@cf/zai-org/glm-4.7-flash`, D1/SQLite migrations, framework-free browser JavaScript, CSS, Node test runner, JSDOM.

## Global Constraints

- Inject all six existing translation rules server-side; user input cannot replace them.
- Single-sentence translation receives the complete target sentence and its complete natural paragraph, without truncating the paragraph.
- Cache identity is `user_id + normalized_sentence + normalized_paragraph + model + rules_version`, hashed with SHA-256.
- Cache data is never shared across users; identical context may be reused across the same user's articles.
- Restoring a local display preference must never trigger Workers AI automatically.
- `original`, `sentence`, and `full` are mutually exclusive display modes.
- Clicking English text continues to read it aloud; only the sentence slot triggers translation.
- Keep every `/api/*` request network-only in the PWA Service Worker.
- Do not add a frontend framework, build step, Durable Object, KV namespace, or new npm dependency.
- Do not execute a remote D1 migration or deploy from this plan.

---

## File Structure

- Create `migrations/0010_sentence_translation_cache.sql`: user-scoped context-aware translation cache.
- Create `src/sentence-translations-api.js`: owned-article lookup, sentence/context derivation, cache lookup, AI generation, and atomic save.
- Modify `src/translation-api.js`: expose one strict plain-translation service and stable error mapping for reuse without changing current endpoints.
- Modify `src/index.js`: route the new article sentence-translation endpoint.
- Create `public/lib/translation-preferences.js`: validate and persist `original | sentence | full` without mixing translation state into typography preferences.
- Modify `public/reader-view.js`: toolbar translation trigger/panel, display-mode state, cached sentence loading, stable sentence slots, and full-title relocation.
- Modify `public/styles.css`: toolbar trigger, anchored panel, active mode, sentence units, fixed-minimum translation slots, and mobile behavior.
- Modify `tests/helpers/sqlite-db.js`: apply migration 0010 in integration tests.
- Modify `tests/translations-api.test.js`: migration, cache, context, isolation, refresh, validation, concurrency, and source-change coverage.
- Create `tests/translation-preferences.test.js`: storage validation and fallback coverage.
- Modify `tests/reader-pending-dom.test.js`: toolbar/panel, mode switching, cache restoration, slot states, stale response, speech separation, and full translation behavior.
- Modify `tests/static-shell.test.js`: styling, touch target, and network-only regression assertions.
- Modify `README.md`: document the new migration and the user-facing translation modes.

---

### Task 1: Add the user-scoped sentence translation cache

**Files:**
- Create: `migrations/0010_sentence_translation_cache.sql`
- Modify: `tests/helpers/sqlite-db.js`
- Modify: `tests/translations-api.test.js`

**Interfaces:**
- Produces: D1 table `sentence_translation_cache` with primary key `(user_id, cache_key)`.
- Produces: indexed lookup fields `user_id`, `model`, `rules_version`, and `updated_at` for later API tasks.

- [ ] **Step 1: Write the failing migration test**

Add this test beside the existing `article_translations` migration test:

```js
test('sentence translation migration creates a user-scoped reusable cache', () => {
  const DB = createSqliteDb();
  try {
    assert.deepEqual(
      DB.all('PRAGMA table_info(sentence_translation_cache)').map(row => row.name),
      [
        'user_id', 'cache_key', 'source_hash', 'context_hash', 'sentence_text',
        'translation_zh', 'model', 'rules_version', 'created_at', 'updated_at'
      ]
    );
    const foreignKeys = DB.all('PRAGMA foreign_key_list(sentence_translation_cache)');
    assert.ok(foreignKeys.some(key => key.table === 'users' && key.on_delete === 'CASCADE'));
  } finally {
    DB.close();
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="sentence translation migration" tests/translations-api.test.js
```

Expected: FAIL because `sentence_translation_cache` does not exist.

- [ ] **Step 3: Add migration 0010 and include it in the SQLite test helper**

Create `migrations/0010_sentence_translation_cache.sql`:

```sql
CREATE TABLE IF NOT EXISTS sentence_translation_cache (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  sentence_text TEXT NOT NULL,
  translation_zh TEXT NOT NULL,
  model TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_sentence_translation_cache_lookup
  ON sentence_translation_cache(user_id, model, rules_version, updated_at DESC);
```

Append the migration URL after `0009_article_translations.sql` in `tests/helpers/sqlite-db.js`:

```js
new URL('../../migrations/0010_sentence_translation_cache.sql', import.meta.url)
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
node --test --test-name-pattern="sentence translation migration" tests/translations-api.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the migration**

```powershell
git add migrations/0010_sentence_translation_cache.sql tests/helpers/sqlite-db.js tests/translations-api.test.js
git commit -m "feat: add sentence translation cache schema"
```

---

### Task 2: Expose a reusable strict translation service

**Files:**
- Modify: `src/translation-api.js`
- Modify: `tests/translations-api.test.js`

**Interfaces:**
- Produces: `TRANSLATION_RULES_VERSION = 'sentence-v1'`.
- Produces: `generatePlainTranslation(env, prompt): Promise<string>`; throws an error carrying `translationCode` and `httpStatus` for every stable failure.
- Produces: `translationFailureResponse(error): Response`.
- Preserves: all current word, selection, and full-article endpoint response shapes.

- [ ] **Step 1: Write failing service-level regression tests**

Import the new exports and add:

```js
import {
  generatePlainTranslation,
  TRANSLATION_RULES_VERSION,
  translationFailureResponse
} from '../src/translation-api.js';

test('strict translation service returns only a validated translation', async () => {
  const value = await generatePlainTranslation({
    AI: { async run() { return { response: '{"translation":"译文"}' }; } }
  }, 'Translate this sentence.');
  assert.equal(value, '译文');
  assert.equal(TRANSLATION_RULES_VERSION, 'sentence-v1');
});

test('strict translation service exposes stable format failures', async () => {
  await assert.rejects(
    generatePlainTranslation({
      AI: { async run() { return { response: '解释：译文' }; } }
    }, 'Translate this sentence.'),
    error => error.translationCode === 'TRANSLATION_FORMAT_INVALID'
  );
});
```

- [ ] **Step 2: Run the focused tests and verify missing exports fail**

```powershell
node --test --test-name-pattern="strict translation service" tests/translations-api.test.js
```

Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Extract strict plain translation generation**

Add typed failure creation and export the strict generator:

```js
export const TRANSLATION_RULES_VERSION = 'sentence-v1';

function translationError(code, status = 503) {
  return Object.assign(new Error('translation unavailable'), {
    translationCode: code,
    httpStatus: status
  });
}

export async function generatePlainTranslation(env, prompt) {
  if (!env.AI?.run) throw translationError('TRANSLATION_NOT_CONFIGURED');
  try {
    const result = await runTranslationModel(env, {
      messages: [
        {
          role: 'system',
          content: `${TRANSLATION_RULES}\n为便于服务端校验，必须严格返回 {"translation":"译文"} JSON，不能使用 Markdown 代码块，不能添加其他字段或 JSON 外文字。`
        },
        { role: 'user', content: `${prompt}\n把唯一的译文放入 translation 字段。` }
      ],
      temperature: 0,
      max_completion_tokens: 512
    });
    const translation = parsePlainResult(responseText(result));
    if (!translation) throw translationError('TRANSLATION_FORMAT_INVALID', 502);
    return translation;
  } catch (error) {
    if (error?.translationCode) throw error;
    const status = Number(error?.status || error?.cause?.status || 0);
    if (status === 429) throw translationError('TRANSLATION_DAILY_LIMIT', 429);
    if (error?.code === 'TRANSLATION_TIMEOUT') {
      throw translationError('TRANSLATION_TIMEOUT', 504);
    }
    throw translationError('TRANSLATION_UNAVAILABLE');
  }
}

export function translationFailureResponse(error) {
  return aiFailure(error?.translationCode || 'TRANSLATION_UNAVAILABLE', error?.httpStatus || 503);
}
```

Change the existing plain endpoint wrapper to:

```js
async function translatePlainText(env, prompt) {
  try {
    return jsonResponse({ translation: await generatePlainTranslation(env, prompt) });
  } catch (error) {
    return translationFailureResponse(error);
  }
}
```

- [ ] **Step 4: Run translation API regression tests**

```powershell
node --test tests/translations-api.test.js
```

Expected: all translation tests PASS, including timeout and daily-limit mappings.

- [ ] **Step 5: Commit the service extraction**

```powershell
git add src/translation-api.js tests/translations-api.test.js
git commit -m "refactor: share strict translation generation"
```

---

### Task 3: Implement context-aware sentence translation APIs

**Files:**
- Create: `src/sentence-translations-api.js`
- Modify: `src/index.js`
- Modify: `tests/translations-api.test.js`

**Interfaces:**
- Consumes: `splitArticleParagraphs(body)` and Task 2's strict translation exports.
- Produces: `handleSentenceTranslationsApi(request, env, path, userId): Promise<Response>`.
- Produces: `GET /api/articles/:id/sentence-translations` returning `{ sentences: CachedSentenceTranslation[] }`.
- Produces: `POST /api/articles/:id/sentence-translations` accepting `{ sentenceIndex, sourceHash, refresh? }`.
- Defines: `CachedSentenceTranslation = { sentenceIndex: number, sourceHash: string, translation: string }`.

- [ ] **Step 1: Add failing tests for context, cache reuse, and user isolation**

Add integration tests that seed two articles and two users. The core assertions must be:

```js
assert.match(modelPrompt, /Target sentence: "Fine\."/);
assert.match(modelPrompt, /Complete paragraph context: "After a long argument, she said, Fine\."/);
assert.equal(secondResponse.cached, true);
assert.equal(aiCalls, 1);
assert.equal(otherUserResponse.sentences.length, 0);
```

Also assert that the same sentence in a different paragraph calls AI again, while the same sentence and paragraph in another owned article reuses the cache.

- [ ] **Step 2: Add failing tests for validation, refresh, source changes, and malformed AI output**

Cover these exact outcomes:

```js
assert.equal(staleResponse.status, 409);
assert.equal((await staleResponse.json()).code, 'TRANSLATION_SOURCE_CHANGED');
assert.equal(oversizedResponse.status, 413);
assert.equal(refreshBody.cached, false);
assert.equal(aiCallsAfterRefresh, 2);
assert.equal(DB.get('SELECT translation_zh FROM sentence_translation_cache WHERE user_id = ?', 'u1').translation_zh, '新译文');
```

For a failed refresh, assert the old row remains unchanged. For an article changed while AI is pending, assert no new row is stored.

- [ ] **Step 3: Run focused tests and verify the route is missing**

```powershell
node --test --test-name-pattern="sentence translation (cache|context|refresh|source|user)" tests/translations-api.test.js
```

Expected: FAIL with 404 or missing table/API behavior.

- [ ] **Step 4: Implement stable hashing, article-derived context, and batched cache reads**

Create `src/sentence-translations-api.js` with these core definitions:

```js
import { jsonResponse } from './http.js';
import { splitArticleParagraphs } from '../public/lib/text.js';
import {
  generatePlainTranslation,
  TRANSLATION_MODEL,
  TRANSLATION_RULES_VERSION,
  translationFailureResponse
} from './translation-api.js';

const SENTENCE_LIMIT = 2000;
const CONTEXT_LIMIT = 30000;
const LOOKUP_BATCH_SIZE = 50;

function normalizeSource(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function identity(userId, sentence, paragraph) {
  const normalizedSentence = normalizeSource(sentence);
  const normalizedParagraph = normalizeSource(paragraph);
  return {
    sentence: normalizedSentence,
    paragraph: normalizedParagraph,
    sourceHash: await sha256(normalizedSentence),
    contextHash: await sha256(normalizedParagraph),
    cacheKey: await sha256(JSON.stringify([
      userId, normalizedSentence, normalizedParagraph,
      TRANSLATION_MODEL, TRANSLATION_RULES_VERSION
    ]))
  };
}
```

Build a sentence descriptor by locating the global sentence index inside `splitArticleParagraphs(article.body).paragraphs`. Never accept sentence or paragraph text from the request body. Query cache keys in chunks of 50 so large articles do not exceed D1 bind limits.

Reject the POST before cache or AI access unless all conditions hold:

```js
Number.isInteger(body.sentenceIndex) && body.sentenceIndex >= 0
typeof body.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(body.sourceHash)
(body.refresh === undefined || typeof body.refresh === 'boolean')
identity.sentence.length > 0 && Array.from(identity.sentence).length <= SENTENCE_LIMIT
Array.from(identity.paragraph).length <= CONTEXT_LIMIT
```

- [ ] **Step 5: Implement GET and POST with atomic source validation**

The POST prompt must be exactly structured as:

```js
const prompt = [
  `Target sentence: ${JSON.stringify(item.identity.sentence)}`,
  `Complete paragraph context: ${JSON.stringify(item.identity.paragraph)}`,
  'Use the complete paragraph only to resolve context. Translate only the target sentence into natural Simplified Chinese.'
].join('\n');
```

Save only after successful strict validation, using the original article body in the `INSERT ... SELECT` guard:

```sql
INSERT INTO sentence_translation_cache
  (user_id, cache_key, source_hash, context_hash, sentence_text,
   translation_zh, model, rules_version, created_at, updated_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
FROM articles
WHERE id = ? AND user_id = ? AND body = ?
ON CONFLICT(user_id, cache_key) DO UPDATE SET
  source_hash = excluded.source_hash,
  context_hash = excluded.context_hash,
  sentence_text = excluded.sentence_text,
  translation_zh = excluded.translation_zh,
  model = excluded.model,
  rules_version = excluded.rules_version,
  updated_at = excluded.updated_at
```

If `meta.changes` is zero, return `TRANSLATION_SOURCE_CHANGED` and do not report success. A cache read error must propagate as a 500 response and must not fall through to AI generation.

- [ ] **Step 6: Route the endpoint**

Import the handler in `src/index.js` and route before the full-article translation handler:

```js
if (/^\/api\/articles\/[a-zA-Z0-9-]+\/sentence-translations$/.test(path)) {
  return await handleSentenceTranslationsApi(request, env, path, userId);
}
```

- [ ] **Step 7: Run all translation API tests**

```powershell
node --test tests/translations-api.test.js
```

Expected: all tests PASS; cache hits report `cached: true`, refreshes report `cached: false`, and invalid requests make zero AI calls.

- [ ] **Step 8: Commit the sentence API**

```powershell
git add src/sentence-translations-api.js src/index.js tests/translations-api.test.js
git commit -m "feat: cache context-aware sentence translations"
```

---

### Task 4: Persist translation display mode safely

**Files:**
- Create: `public/lib/translation-preferences.js`
- Create: `tests/translation-preferences.test.js`

**Interfaces:**
- Produces: `TRANSLATION_MODE_KEY = 'pc-reader-translation-mode'`.
- Produces: `TRANSLATION_MODES = Object.freeze(['original', 'sentence', 'full'])`.
- Produces: `loadTranslationMode(storage): 'original' | 'sentence' | 'full'`.
- Produces: `saveTranslationMode(storage, mode): boolean`.

- [ ] **Step 1: Write failing preference tests**

```js
test('translation mode persists only supported values', () => {
  const storage = memoryStorage();
  assert.equal(loadTranslationMode(storage), 'original');
  assert.equal(saveTranslationMode(storage, 'sentence'), true);
  assert.equal(loadTranslationMode(storage), 'sentence');
  assert.equal(saveTranslationMode(storage, 'invalid'), false);
  assert.equal(loadTranslationMode(storage), 'sentence');
});

test('translation mode tolerates corrupt and unavailable storage', () => {
  assert.equal(loadTranslationMode({ getItem() { return 'broken'; } }), 'original');
  assert.equal(loadTranslationMode({ getItem() { throw new Error('disabled'); } }), 'original');
  assert.equal(saveTranslationMode({ setItem() { throw new Error('disabled'); } }, 'full'), false);
});
```

- [ ] **Step 2: Run tests and verify the module is missing**

```powershell
node --test tests/translation-preferences.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the focused storage helper**

```js
export const TRANSLATION_MODE_KEY = 'pc-reader-translation-mode';
export const TRANSLATION_MODES = Object.freeze(['original', 'sentence', 'full']);

export function loadTranslationMode(storage) {
  try {
    const mode = storage?.getItem?.(TRANSLATION_MODE_KEY);
    return TRANSLATION_MODES.includes(mode) ? mode : 'original';
  } catch {
    return 'original';
  }
}

export function saveTranslationMode(storage, mode) {
  if (!TRANSLATION_MODES.includes(mode)) return false;
  try {
    storage?.setItem?.(TRANSLATION_MODE_KEY, mode);
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run preference tests**

```powershell
node --test tests/translation-preferences.test.js
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit preferences**

```powershell
git add public/lib/translation-preferences.js tests/translation-preferences.test.js
git commit -m "feat: persist reader translation mode"
```

---

### Task 5: Replace standalone full-translation controls with the toolbar panel

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Modify: `tests/reader-pending-dom.test.js`
- Modify: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: Task 4's translation mode helper.
- Produces: toolbar action `translation-menu`, panel role `translation-panel`, and mode actions `translation-mode` with values `original | sentence | full`.
- Preserves: `PUT /api/articles/:id/translation` and paragraph translation rendering.

- [ ] **Step 1: Rewrite the existing full-translation DOM test to express the new UI**

Assert all of the following:

```js
const trigger = env.root.querySelector('[data-action="translation-menu"]');
assert.ok(trigger);
assert.equal(trigger.getAttribute('aria-label'), '翻译');
assert.equal(trigger.nextElementSibling?.dataset.action, 'reader-settings');
assert.equal(env.root.querySelector('.pc-reader-translation-controls'), null);

click(env.window, trigger);
assert.ok(env.root.querySelector('[data-role="translation-panel"]'));
click(env.window, env.root.querySelector('[data-action="translation-mode"][data-mode="full"]'));
await env.ready();
assert.ok(calls.some(call => call.path === '/api/articles/a1/translation' && initMethod(call) === 'PUT'));
assert.equal(env.root.querySelector('[data-role="article-translation-title"]').textContent, '测试文章');
assert.ok(env.root.querySelector('[data-role="article-translation-title"]').previousElementSibling.matches('.pc-reader-title'));
```

- [ ] **Step 2: Add tests for mode restoration without automatic AI use**

Preload storage with `full`, make GET return `{ status: 'missing' }`, and assert:

```js
assert.equal(aiPutCalls, 0);
assert.equal(storage.getItem('pc-reader-translation-mode'), 'original');
assert.equal(env.root.querySelector('[data-action="translation-menu"]').getAttribute('aria-pressed'), 'false');
```

Also test that an existing full translation restores full mode without a PUT request.

- [ ] **Step 3: Run the focused reader tests and verify they fail**

```powershell
node --test --test-name-pattern="translation (toolbar|panel|mode|restoration)" tests/reader-pending-dom.test.js
```

Expected: FAIL because the standalone controls still render.

- [ ] **Step 4: Add the translation icon and toolbar trigger**

Add a `translate` SVG entry to `POPOVER_ICONS`, create the button immediately before the existing settings button, and append both at the toolbar's right edge:

```js
const translate = iconButton(
  'translation-menu', '翻译', 'translate',
  'pc-btn-ghost pc-reader-translation-trigger'
);
translate.setAttribute('aria-expanded', 'false');
translate.setAttribute('aria-haspopup', 'dialog');
translate.setAttribute('aria-pressed', String(translationMode !== 'original'));
toolbar.append(translate, settings);
```

Remove `header.append(translationControls())` and delete `translationControls()` plus `toggleArticleTranslation()` after the mode panel replaces them.

- [ ] **Step 5: Implement the anchored translation panel and mode transitions**

Create `openTranslationPanel(trigger)`, `closeTranslationPanel({ restoreFocus })`, and `setTranslationMode(mode)` using the same focus restoration and `positionAnchoredPanel` pattern as reader settings. The mode transition must follow:

```js
async function setTranslationMode(mode) {
  if (mode === 'full' && !articleTranslation) {
    await translateArticle();
    if (!articleTranslation) return;
  }
  translationMode = mode;
  saveTranslationMode(storage, mode);
  closeTranslationPanel({ restoreFocus: false });
  render();
}
```

Change `translateArticle` so it no longer mutates a detached button's text. It updates `translationBusy`, rerenders the panel state, and only switches to `full` after success. A refresh failure retains the old `articleTranslation` and current mode.

Render `articleTranslation.titleZh` directly after `.pc-reader-title` only when mode is `full`. Render paragraph translations only when mode is `full`.

- [ ] **Step 6: Add toolbar/panel styles and static assertions**

Use the existing ghost-button tokens:

```css
.pc-reader-translation-trigger {
  width: 44px; min-width: 44px; min-height: 44px; padding: 8px;
  display: inline-grid; place-items: center; margin-inline-start: auto;
}
.pc-reader-translation-trigger svg { width: 18px; height: 18px; }
.pc-reader-translation-trigger[aria-pressed="true"] {
  color: var(--teal);
  border-color: color-mix(in srgb, var(--teal) 55%, var(--line));
  background: color-mix(in srgb, var(--teal) 10%, transparent);
}
.pc-reader-translation-title {
  margin: -4px 0 0; color: var(--ink-dim);
  font-size: clamp(1.05rem, 3vw, 1.35rem); line-height: 1.4;
}
```

The panel reuses the reader settings panel surface, focus, safe-area, and mobile positioning rules instead of introducing a new visual language.

- [ ] **Step 7: Run reader and static-shell tests**

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all tests PASS; no standalone translation control row remains.

- [ ] **Step 8: Commit the toolbar redesign**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "feat: move translation controls into reader toolbar"
```

---

### Task 6: Render stable sentence slots and connect them to the cache API

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Modify: `tests/reader-pending-dom.test.js`
- Modify: `tests/static-shell.test.js`

**Interfaces:**
- Consumes: `GET/POST /api/articles/:id/sentence-translations` from Task 3.
- Produces: slot roles `sentence-translation-slot`, `sentence-translation`, and actions `translate-sentence`, `refresh-sentence-translation`.
- Maintains: `sentenceTranslations: Map<number, { sourceHash: string, translation: string }>` and per-sentence request generations.

- [ ] **Step 1: Add failing tests for stable slots and speech separation**

In sentence mode, assert:

```js
const sentence = env.root.querySelector('[data-sentence-index="0"]');
const slot = env.root.querySelector('[data-role="sentence-translation-slot"][data-sentence-index="0"]');
assert.ok(slot);
assert.equal(slot.dataset.state, 'idle');

click(env.window, sentence);
assert.equal(env.speech.calls.at(-1)[0], 'speakOnce');
assert.equal(sentenceTranslationPosts, 0);

click(env.window, slot.querySelector('[data-action="translate-sentence"]'));
await env.ready();
assert.equal(sentenceTranslationPosts, 1);
assert.equal(slotHeightBefore, slot.getBoundingClientRect().height);
assert.equal(env.root.querySelector('[data-role="sentence-translation"]').textContent, '第一句。');
```

The test DOM does not calculate CSS layout, so enforce visual stability through class/state invariants plus the static CSS test for `min-height`.

- [ ] **Step 2: Add failing tests for restore, independent errors, refresh, and stale responses**

Cover:

- GET restores only returned cached sentence indexes and makes no POST calls.
- One sentence can be `loading` while another remains clickable.
- A failed POST renders an in-slot retry and preserves translations in other slots.
- Refresh sends `{ refresh: true }`; refresh failure keeps the old translation visible.
- An older response after a newer same-sentence request or cleanup cannot change the DOM.
- Switching to `full` removes sentence slots; switching back restores the in-memory cached map.

- [ ] **Step 3: Run focused tests and verify slot behavior is missing**

```powershell
node --test --test-name-pattern="sentence translation (slot|restore|refresh|stale|speech)" tests/reader-pending-dom.test.js
```

Expected: FAIL because sentence mode does not render slots.

- [ ] **Step 4: Add sentence cache state and lazy restoration**

Inside `createReaderView`, add:

```js
let sentenceTranslations = new Map();
const sentenceTranslationStates = new Map();
const sentenceTranslationGenerations = new Map();
let sentenceTranslationsLoaded = false;

async function loadSentenceTranslations() {
  if (sentenceTranslationsLoaded) return;
  const result = await api(`/api/articles/${encodeURIComponent(articleId)}/sentence-translations`);
  if (!mounted) return;
  sentenceTranslations = new Map((result?.sentences || []).map(item => [item.sentenceIndex, item]));
  sentenceTranslationsLoaded = true;
}
```

Call this when sentence mode becomes active, including restored sentence mode. Render slots immediately, then rerender when cached results arrive. A GET failure must place a non-blocking reader error and leave idle slots usable for retry.

- [ ] **Step 5: Render sentence units only in sentence mode**

Keep the current `<p>` paragraph structure in `original` and `full` modes. In `sentence` mode render:

```js
const unit = element('div', 'pc-reader-sentence-unit');
unit.append(renderSentence(sentence, candidates));
unit.append(renderSentenceTranslationSlot(sentence));
paragraphNode.append(unit);
```

Use a `div.pc-reader-paragraph.pc-reader-paragraph-sentence-mode` instead of `<p>` so block-level slots remain valid HTML. Preserve pause markers, term highlights, global sentence indexes, keyboard speech, and Media Session behavior.

- [ ] **Step 6: Implement translate, retry, and refresh actions**

Compute the current source hash in the browser at request time:

```js
async function sentenceSourceHash(text) {
  const normalized = String(text ?? '').normalize('NFKC').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
```

POST this body:

```js
{
  sentenceIndex,
  sourceHash: await sentenceSourceHash(sentences[sentenceIndex].text),
  refresh
}
```

Use a generation number per sentence. On success, update `sentenceTranslations`, set state to `translated`, and rerender only if still mounted/current. On ordinary failure set `error`; on refresh failure retain the old translation and attach a retry message without removing it.

- [ ] **Step 7: Add stable slot and mobile styles**

```css
.pc-reader-paragraph-sentence-mode { display: grid; gap: .55em; }
.pc-reader-sentence-unit { display: grid; gap: 4px; }
.pc-sentence-translation-slot {
  min-height: calc(2 * 1.75em + 12px);
  padding: 6px 10px; border-radius: 8px;
  color: var(--ink-dim);
  background: color-mix(in srgb, var(--bg-panel) 72%, transparent);
}
.pc-sentence-translation-action {
  width: 100%; min-height: 44px; border: 0; background: transparent;
  color: inherit; text-align: left; cursor: pointer;
}
.pc-sentence-translation-text {
  margin: 0; color: var(--ink-dim); line-height: 1.75;
  font-family: 'Noto Sans SC', sans-serif;
}
```

Long translations grow naturally; do not apply line clamping or fixed `height`.

- [ ] **Step 8: Run reader and style tests**

```powershell
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all tests PASS, including existing selection, speech, focus, cleanup, and paragraph translation cases.

- [ ] **Step 9: Commit sentence slots**

```powershell
git add public/reader-view.js public/styles.css tests/reader-pending-dom.test.js tests/static-shell.test.js
git commit -m "feat: add stable inline sentence translations"
```

---

### Task 7: Final integration, documentation, and regression verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Verifies the complete feature; produces no new runtime API.

- [ ] **Step 1: Document local migration and reader behavior**

Add these operational facts to `README.md`:

```markdown
- 单句翻译按“用户 + 原句 + 完整自然段 + 模型 + 规则版本”缓存在 D1；相同上下文重复翻译不会再次调用 Workers AI。
- 阅读器右上角翻译面板可切换原文、逐句翻译和全文译文；恢复偏好不会自动生成缺失译文。
- 部署此版本前需应用 `migrations/0010_sentence_translation_cache.sql`。
```

- [ ] **Step 2: Run the focused backend suite**

```powershell
node --test tests/translations-api.test.js
```

Expected: all translation tests PASS.

- [ ] **Step 3: Run the focused frontend suite**

```powershell
node --test tests/translation-preferences.test.js tests/reader-pending-dom.test.js tests/static-shell.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 4: Run both required project test commands**

```powershell
npm.cmd test
npm.cmd run test:all
```

Expected: both commands exit 0 with zero failed, cancelled, or skipped tests.

- [ ] **Step 5: Run repository integrity checks**

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. Status lists only the intended `README.md` change before the documentation commit.

- [ ] **Step 6: Commit documentation and any final reviewed fixes**

```powershell
git add README.md
git commit -m "docs: explain cached sentence translation"
```

- [ ] **Step 7: Perform manual browser/device acceptance without deployment**

Apply migration 0010 to the local D1 database and start local development:

```powershell
wrangler d1 migrations apply phonetic_cards_db --local
wrangler dev
```

Then verify:

1. Desktop: translation icon aligns with reading settings; Escape closes the panel and restores focus.
2. Android Chrome: sentence slots have 44px targets and typical translations do not move following content.
3. iPhone Safari: the panel respects safe-area insets and long translations expand without clipping.
4. All platforms: tapping English reads; tapping its slot translates; full and sentence modes never show simultaneously.
5. Reopen the same article and confirm cached sentences restore without a POST or AI call.

Do not apply migration 0010 remotely and do not deploy as part of this task.
