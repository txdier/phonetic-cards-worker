# Article Practice and Vocabulary Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a responsive English article library and reader with global pending-term marking, word-form-aware vocabulary lookup, speech playback, reading progress, and per-article practice statistics.

**Architecture:** Keep article bodies as canonical plain text in D1 and parse sentences and term matches in the browser at read time. Persist articles, global pending terms, explicit article marking sources, vocabulary forms, progress aggregates, and idempotent progress events. Split the current monolithic frontend and Worker into focused ES modules while preserving existing word learning and self-test behavior.

**Tech Stack:** Cloudflare Workers, D1 SQLite, Worker Assets, browser ES modules, Web Speech API, Node.js 24 built-in test runner, Wrangler 4.110.0.

## Global Constraints

- English articles only in this release.
- Article input is plain text; preserve paragraphs and line breaks, but do not parse Markdown or rich text.
- Article title and body are required; author, free-text source, and notes are optional.
- No URL extraction, file import, tags, categories, search, filtering, translation lookup, automatic lemmatization, or full offline mode.
- Mobile and desktop are equally important; the reader uses a focused single-column layout.
- A selectable phrase may contain any number of words but cannot cross a sentence boundary.
- Pending-term matching is user-global, case-insensitive, whitespace-normalized, and longest-match-first.
- Automatic highlighting in another article is not an explicit marking source until the user confirms it there.
- Article-local cancellation removes only that article source; cancellation from the global pending page removes every source and the pending term.
- Existing vocabulary uses an original form plus manually managed forms; no automatic stemming.
- When merging a new form into an existing card, append a non-duplicate Chinese meaning with ；, retain the existing example, and add the new form.
- Full-read count increments only after a top-to-bottom traversal.
- Active reading time pauses after 60 seconds without scroll, selection, click, or speech interaction.
- Full read-aloud count increments only after reaching the article end and playing at least 80% of its sentences.
- Prefer an en-US speech voice, then any English voice.
- Speech rate uses a 0.5x to 1.5x range input with a 0.5x step.
- Use new migrations only for this feature after the baseline commit.
- Treat the currently staged .gitignore, 0001_create_words_table.sql, and 0002_add_users.sql changes as the approved baseline.
- Work directly in the current checkout on branch codex/article-practice; do not create a worktree.
- Keep the unstaged wrangler.toml database ID change local and out of every commit.

## Scope Check

This remains one cohesive vertical feature rather than separate projects: article storage, explicit marking sources, vocabulary forms, reader interaction, speech, and statistics share the same lifecycle and acceptance story. The tasks below keep reviewer-sized boundaries and leave the application working at every commit.

---

## File Map

### Existing files modified

- public/index.html — static application shell.
- public/app.js — created by extracting the current inline application, then reduced to authentication, route, theme, and module coordination.
- public/styles.css — extracted current styles plus new responsive article styles.
- src/index.js — thin request router and asset fallback.
- README.md — new schema and article workflow instructions.

### New backend and schema files

- migrations/0003_article_practice.sql — article, marking, word-form, progress, and event tables.
- src/http.js — JSON responses, structured request errors, and route helpers.
- src/auth.js — current login and session behavior.
- src/words-api.js — existing word API plus original/form support.
- src/articles-api.js — article CRUD and edit/delete cleanup.
- src/markings-api.js — marking sources, pending list, and word conversion.
- src/progress-api.js — idempotent progress updates.
- src/stats-api.js — per-article statistics.

### New frontend files

- public/api.js — fetch wrapper and stable API errors.
- public/routes.js — pure hash-route parser that is safe to test without a DOM.
- public/words-view.js — existing learning and self-test UI.
- public/articles-view.js — article library and forms.
- public/reader-view.js — interactive reader, selection bar, and word lookup.
- public/pending-view.js — global pending organizer.
- public/stats-view.js — per-article metrics.
- public/lib/text.js — shared pure normalization, sentence, selection, and match helpers.
- public/lib/speech.js — word, sentence, and sequenced article speech.
- public/lib/reading-session.js — active time and completion state machine.

### Test files

- package.json — Node test scripts.
- tests/static-shell.test.js
- tests/auth.test.js
- tests/text.test.js
- tests/articles-api.test.js
- tests/markings-api.test.js
- tests/progress-api.test.js
- tests/speech.test.js
- tests/reading-session.test.js
- tests/helpers/fake-db.js

## Shared Interfaces

~~~js
// public/lib/text.js
export function normalizeTerm(value) {}
export function splitSentences(text, segmenter = null) {}
export function validateSelection({ text, startSentence, endSentence }) {}
export function findTermMatches(text, entries) {}
export function containsNormalizedTerm(text, normalizedTerm) {}

// public/lib/speech.js
export function createSpeechController({ speechSynthesis, Utterance }) {}

// public/lib/reading-session.js
export function createReadingSession({ now, idleMs = 60_000 }) {}

// Worker handlers
export async function handleWordsApi(request, env, path, userId) {}
export async function handleArticlesApi(request, env, path, userId) {}
export async function handleMarkingsApi(request, env, path, userId) {}
export async function handleProgressApi(request, env, path, userId) {}
export async function handleStatsApi(request, env, path, userId) {}
~~~

Validation errors use this JSON shape:

~~~json
{ "error": "Human-readable Chinese message", "code": "STABLE_MACHINE_CODE" }
~~~

---

### Task 0: Commit the Approved Baseline and Create the Feature Branch

**Files:**
- Commit only: .gitignore
- Commit only: migrations/0001_create_words_table.sql
- Commit only: migrations/0002_add_users.sql
- Preserve unstaged: wrangler.toml

**Interfaces:**
- Consumes: user approval that the three staged files are the implementation baseline.
- Produces: a baseline commit and current checkout on codex/article-practice.

- [ ] **Step 1: Verify the staged baseline**

Run:

~~~powershell
git diff --cached --name-only
git diff --cached -- .gitignore migrations/0001_create_words_table.sql migrations/0002_add_users.sql
git diff -- wrangler.toml
~~~

Expected: cached names are exactly the three approved files; wrangler.toml appears only in the unstaged diff.

- [ ] **Step 2: Commit only the baseline**

~~~powershell
git commit --only -m "chore: establish user-scoped schema baseline" -- .gitignore migrations/0001_create_words_table.sql migrations/0002_add_users.sql
~~~

Expected: one commit with those three paths; git status --short still reports an unstaged wrangler.toml modification.

- [ ] **Step 3: Create and verify the direct feature branch**

~~~powershell
git switch -c codex/article-practice
git branch --show-current
git status --short
~~~

Expected: current branch is codex/article-practice and only the local wrangler.toml modification remains.

---

### Task 1: Add the Test Harness and Extract the Static Frontend Shell

**Files:**
- Create: package.json
- Create: tests/static-shell.test.js
- Create: public/styles.css
- Create: public/app.js
- Modify: public/index.html:1-615

**Interfaces:**
- Consumes: current inline CSS and JavaScript.
- Produces: npm test, /app.js, /styles.css, and unchanged login, learning, self-test, theme, and speech behavior.

- [ ] **Step 1: Write the failing shell test and package script**

~~~json
{
  "name": "phonetic-cards-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js",
    "test:all": "node --test tests/**/*.test.js"
  }
}
~~~

~~~js
// tests/static-shell.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index loads external application assets', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /type="module" src="\/app\.js"/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /<script>\s*\(function/);
});
~~~

- [ ] **Step 2: Run the test and verify failure**

Run: npm test

Expected: FAIL because index.html still contains inline style and script blocks.

- [ ] **Step 3: Extract existing behavior**

Replace public/index.html with:

~~~html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>语音卡片 · Phonetic Cards</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="pc-root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
~~~

Move the existing style block contents unchanged into public/styles.css. Move the existing IIFE body unchanged into public/app.js, keeping the root lookup as its first runtime statement. Use apply_patch for both moves.

- [ ] **Step 4: Run regression checks**

~~~powershell
npm test
wrangler dev
~~~

Expected: tests PASS; login, learning, self-test, add/delete/judge, theme, logout, and speech work; the browser console has no asset or module error.

- [ ] **Step 5: Commit**

~~~powershell
git add package.json tests/static-shell.test.js public/index.html public/styles.css public/app.js
git commit -m "refactor: extract frontend shell modules"
~~~

---

### Task 2: Extract Worker Auth, HTTP, and Existing Words API

**Files:**
- Create: src/http.js
- Create: src/auth.js
- Create: src/words-api.js
- Create: tests/auth.test.js
- Modify: src/index.js:1-204

**Interfaces:**
- Consumes: current DB and AUTH environment bindings.
- Produces: jsonResponse, readJson, createSessionToken, verifySessionToken, requireUser, auth handlers, and handleWordsApi.

- [ ] **Step 1: Write failing auth tests**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken } from '../src/auth.js';

test('session token round-trips a user id', async () => {
  const token = await createSessionToken('user-1', 'long-test-secret');
  assert.equal(await verifySessionToken(token, 'long-test-secret'), 'user-1');
});

test('tampered session token is rejected', async () => {
  const token = await createSessionToken('user-1', 'long-test-secret');
  assert.equal(await verifySessionToken(token + 'x', 'long-test-secret'), null);
});
~~~

- [ ] **Step 2: Verify failure**

Run: npm test

Expected: ERR_MODULE_NOT_FOUND for src/auth.js.

- [ ] **Step 3: Extract explicit modules**

~~~js
// src/http.js
export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

export async function readJson(request) {
  try { return await request.json(); }
  catch {
    throw Object.assign(new Error('请求正文必须是 JSON'), {
      status: 400, code: 'INVALID_JSON'
    });
  }
}
~~~

Move the current session implementation into src/auth.js and export createSessionToken, verifySessionToken, handleLogin, handleLogout, handleMe, and requireUser. Move the current words routes into src/words-api.js and export handleWordsApi. Reduce src/index.js to auth routing, authenticated API delegation, structured error conversion, and env.ASSETS fallback.

- [ ] **Step 4: Test existing behavior**

Run: npm test

Expected: PASS. With wrangler dev, /api/me returns 401 without a session and the current words UI still works.

- [ ] **Step 5: Commit**

~~~powershell
git add src/index.js src/http.js src/auth.js src/words-api.js tests/auth.test.js
git commit -m "refactor: split worker request handlers"
~~~

---

### Task 3: Add the D1 Schema

**Files:**
- Create: migrations/0003_article_practice.sql

**Interfaces:**
- Consumes: approved users and words.user_id schema.
- Produces: words.lemma, word_forms, articles, marked_terms, article_markings, article_progress, and article_progress_events.

- [ ] **Step 1: Write the migration**

~~~sql
ALTER TABLE words ADD COLUMN lemma TEXT;
UPDATE words SET lemma = en WHERE lemma IS NULL OR trim(lemma) = '';

CREATE TABLE word_forms (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(word_id, normalized_form)
);

INSERT INTO word_forms (id, word_id, user_id, form, normalized_form, created_at)
SELECT 'legacy:' || id, id, user_id, en, lower(trim(en)), created_at
FROM words WHERE user_id IS NOT NULL;

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE marked_terms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('word', 'phrase')),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, normalized_text)
);

CREATE TABLE article_markings (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_text TEXT NOT NULL,
  selected_text TEXT NOT NULL,
  context_sentence TEXT NOT NULL,
  marked_term_id TEXT REFERENCES marked_terms(id) ON DELETE CASCADE,
  word_id TEXT REFERENCES words(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK((marked_term_id IS NOT NULL AND word_id IS NULL) OR
        (marked_term_id IS NULL AND word_id IS NOT NULL)),
  UNIQUE(article_id, normalized_text)
);

CREATE TABLE article_progress (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_position_ratio REAL NOT NULL DEFAULT 0 CHECK(last_position_ratio BETWEEN 0 AND 1),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
  read_count INTEGER NOT NULL DEFAULT 0,
  active_read_ms INTEGER NOT NULL DEFAULT 0,
  full_read_aloud_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE article_progress_events (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('active_ms', 'read_complete', 'read_aloud_complete')),
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_articles_user_created ON articles(user_id, created_at DESC);
CREATE INDEX idx_word_forms_user_normalized ON word_forms(user_id, normalized_form);
CREATE INDEX idx_marked_terms_user ON marked_terms(user_id, created_at DESC);
CREATE INDEX idx_article_markings_article ON article_markings(article_id);
CREATE INDEX idx_article_markings_pending ON article_markings(marked_term_id);
CREATE INDEX idx_article_markings_word ON article_markings(word_id);
CREATE INDEX idx_progress_events_article ON article_progress_events(article_id, created_at);
~~~

- [ ] **Step 2: Apply to a fresh local database**

Use a dedicated ignored test-state directory so existing local D1 data is never removed. Resolve and verify the absolute target before the recursive delete.

~~~powershell
$expected = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.wrangler/test-state/article-practice'))
$target = [IO.Path]::GetFullPath('.wrangler/test-state/article-practice')
if ($target -ne $expected) { throw "Unexpected test-state path: $target" }
Remove-Item -Recurse -Force -LiteralPath $target -ErrorAction SilentlyContinue
wrangler d1 migrations apply phonetic_cards_db --local --persist-to $target
~~~

Expected: 0001, 0002, and 0003 apply successfully.

- [ ] **Step 3: Verify schema**

~~~powershell
wrangler d1 execute phonetic_cards_db --local --persist-to $target --command "PRAGMA table_info(words); SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
~~~

Expected: words contains lemma and all six new tables exist.

- [ ] **Step 4: Commit**

~~~powershell
git add migrations/0003_article_practice.sql
git commit -m "feat: add article practice schema"
~~~

---

### Task 4: Implement Shared Text Parsing and Matching

**Files:**
- Create: public/lib/text.js
- Create: tests/text.test.js

**Interfaces:**
- Consumes: entries shaped as { id, normalizedText, status, payload }.
- Produces: normalized terms, sentence spans, valid selections, and non-overlapping longest matches.

- [ ] **Step 1: Write failing tests**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTerm, validateSelection, findTermMatches, containsNormalizedTerm
} from '../public/lib/text.js';

test('normalizes case and internal whitespace', () => {
  assert.equal(normalizeTerm('  Take   Part In  '), 'take part in');
});

test('rejects cross-sentence selection', () => {
  assert.deepEqual(
    validateSelection({ text: 'end. Next', startSentence: 0, endSentence: 1 }),
    { ok: false, code: 'CROSS_SENTENCE' }
  );
});

test('prefers the longest non-overlapping term', () => {
  const matches = findTermMatches('We take part in class.', [
    { id: 'take', normalizedText: 'take', status: 'pending' },
    { id: 'phrase', normalizedText: 'take part in', status: 'word' }
  ]);
  assert.deepEqual(matches.map(({ id, text }) => ({ id, text })), [
    { id: 'phrase', text: 'take part in' }
  ]);
});

test('respects English boundaries', () => {
  assert.equal(containsNormalizedTerm('An article.', 'art'), false);
  assert.equal(containsNormalizedTerm('Art matters.', 'art'), true);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/text.test.js

Expected: ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement the pure helpers**

~~~js
const EDGE_PUNCTUATION = /^[^A-Za-z]+|[^A-Za-z]+$/g;

export function normalizeTerm(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function validateSelection({ text, startSentence, endSentence }) {
  if (startSentence !== endSentence) return { ok: false, code: 'CROSS_SENTENCE' };
  const displayText = String(text || '').replace(EDGE_PUNCTUATION, '').trim();
  if (!/[A-Za-z]/.test(displayText)) return { ok: false, code: 'NO_ENGLISH_TEXT' };
  return { ok: true, displayText, normalizedText: normalizeTerm(displayText) };
}
~~~

Implement splitSentences to return { index, start, end, text } using injected or native Intl.Segmenter with a deterministic English punctuation fallback. Implement findTermMatches by sorting entries by word count, character length, then word-over-pending priority; enforce boundaries, reject overlaps, and return source order.

- [ ] **Step 4: Run all tests**

~~~powershell
node --test tests/text.test.js
npm run test:all
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add public/lib/text.js tests/text.test.js
git commit -m "feat: add article text matching core"
~~~

---

### Task 5: Implement Article CRUD and Cleanup

**Files:**
- Create: src/articles-api.js
- Create: tests/articles-api.test.js
- Create: tests/helpers/fake-db.js
- Modify: src/index.js

**Interfaces:**
- Consumes: containsNormalizedTerm, authenticated userId, D1.
- Produces: GET/POST /api/articles and GET/PATCH/DELETE /api/articles/:id.

- [ ] **Step 1: Create the D1 mock and failing tests**

~~~js
// tests/helpers/fake-db.js
export function createFakeDb(queues = {}) {
  const calls = [];
  const take = (name, fallback) => queues[name]?.shift() ?? fallback;
  return {
    calls,
    prepare(sql) {
      const call = { sql: sql.replace(/\s+/g, ' ').trim(), bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) { call.bindings = bindings; return this; },
        first: async () => take('first', null),
        all: async () => take('all', { results: [] }),
        run: async () => take('run', { success: true, meta: { changes: 1 } })
      };
    },
    async batch(statements) {
      return Promise.all(statements.map(statement => statement.run()));
    }
  };
}
~~~

~~~js
test('article list binds the authenticated user', async () => {
  const DB = createFakeDb({ all: [{ results: [] }] });
  const response = await handleArticlesApi(
    new Request('https://app/api/articles'), { DB }, '/api/articles', 'u1'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(DB.calls[0].bindings, ['u1']);
});

test('creation rejects blank title and body', async () => {
  const request = new Request('https://app/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: ' ', body: '' })
  });
  const response = await handleArticlesApi(
    request, { DB: createFakeDb() }, '/api/articles', 'u1'
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'ARTICLE_REQUIRED_FIELDS');
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/articles-api.test.js

Expected: missing articles handler.

- [ ] **Step 3: Implement CRUD**

Normalize line endings and trim outer whitespace:

~~~js
const article = {
  id: crypto.randomUUID(),
  title: String(body.title || '').trim(),
  body: String(body.body || '').replace(/\r\n/g, '\n').trim(),
  author: String(body.author || '').trim(),
  source: String(body.source || '').trim(),
  notes: String(body.notes || '').trim(),
  created_at: Date.now(),
  updated_at: Date.now()
};
~~~

List omits body and includes progress summary. Detail includes the body, progress, explicit markings, pending lexicon, and word/forms required by the reader. Every query binds userId.

Article creation inserts its zeroed article_progress row in the same logical operation as the article so every detail response has a stable progress object.

PATCH accepts resetProgress. Load current explicit markings; retain only terms still found by containsNormalizedTerm; remove missing sources and orphan pending rows. If resetProgress is true, reset the aggregate and delete its events.

DELETE loads affected pending IDs, deletes the owned article, then deletes only pending rows with no remaining explicit sources.

- [ ] **Step 4: Route and test**

~~~js
if (path === '/api/articles' || /^\/api\/articles\/[a-zA-Z0-9-]+$/.test(path)) {
  return handleArticlesApi(request, env, path, userId);
}
~~~

Run: npm run test:all

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add src/index.js src/articles-api.js tests/articles-api.test.js tests/helpers/fake-db.js
git commit -m "feat: add article CRUD API"
~~~

---

### Task 6: Add Vocabulary Originals and Forms

**Files:**
- Modify: src/words-api.js
- Modify: public/app.js
- Create: tests/markings-api.test.js

**Interfaces:**
- Consumes: words.lemma and word_forms.
- Produces: word JSON with lemma and forms; article lookup can match both.

- [ ] **Step 1: Write a failing response test**

~~~js
test('word list includes lemma and forms', async () => {
  const DB = createFakeDb({
    all: [
      { results: [{ id: 'w1', en: 'deploy', lemma: 'deploy', zh: '部署' }] },
      { results: [{ word_id: 'w1', form: 'deployed', normalized_form: 'deployed' }] }
    ]
  });
  const response = await handleWordsApi(
    new Request('https://app/api/words'), { DB }, '/api/words', 'u1'
  );
  const [word] = await response.json();
  assert.equal(word.lemma, 'deploy');
  assert.deepEqual(word.forms.map(item => item.form), ['deployed']);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/markings-api.test.js

Expected: current API does not return forms.

- [ ] **Step 3: Extend the API**

Manual creation uses lemma = normalizeTerm(body.lemma || body.en), inserts submitted en as its first form, and returns:

~~~js
{
  id, en: lemma, lemma, zh, example, stress,
  familiarity: 0, created_at: createdAt,
  forms: [{ form: submittedEn, normalized_form: normalizeTerm(submittedEn) }]
}
~~~

GET makes one user-scoped words query and one forms query, groups by word_id, and defaults legacy lemma to en. Preserve familiarity PATCH and DELETE; cascading keys remove forms and converted article markings.

- [ ] **Step 4: Update word cards**

In the current app.js word renderer, show lemma as primary. If a form differs, show 词形：deployed · deploying. Continue sharing Chinese, example, stress, familiarity, and speech. Task 9 will move this tested renderer into words-view.js without behavior changes.

- [ ] **Step 5: Test and commit**

Run: npm run test:all

Expected: PASS; manual add and self-test still work.

~~~powershell
git add src/words-api.js public/app.js tests/markings-api.test.js
git commit -m "feat: add vocabulary original forms"
~~~

---

### Task 7: Implement Global Marking and Conversion

**Files:**
- Create: src/markings-api.js
- Modify: src/index.js
- Expand: tests/markings-api.test.js

**Interfaces:**
- Consumes: article ownership, normalizeTerm, marking and vocabulary tables.
- Produces: pending list, explicit source create/delete, conflict-aware conversion.

- [ ] **Step 1: Write lifecycle tests**

~~~js
test('appendMeaning appends only a new meaning', () => {
  assert.equal(appendMeaning('部署；配置', '发布'), '部署；配置；发布');
  assert.equal(appendMeaning('部署；配置', '配置'), '部署；配置');
});

test('same lemma returns a resolvable conflict', async () => {
  const DB = createFakeDb({
    first: [{ id: 't1', user_id: 'u1', display_text: 'deployed' }],
    all: [{ results: [{ id: 'w1', lemma: 'deploy', zh: '部署', example: 'Old example.' }] }]
  });
  const request = new Request('https://app/api/marked-terms/t1/add-to-word', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ zh: '发布', lemma: 'deploy', example: 'New example.' })
  });
  const response = await handleMarkingsApi(
    request, { DB }, '/api/marked-terms/t1/add-to-word', 'u1'
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'LEMMA_EXISTS');
  assert.deepEqual(body.matches.map(item => item.id), ['w1']);
});

test('global cancellation deletes every source before the pending row', async () => {
  const DB = createFakeDb({ first: [{ id: 't1', user_id: 'u1' }] });
  const request = new Request('https://app/api/marked-terms/t1', { method: 'DELETE' });
  const response = await handleMarkingsApi(
    request, { DB }, '/api/marked-terms/t1', 'u1'
  );
  assert.equal(response.status, 200);
  assert.match(DB.calls.at(-2).sql, /DELETE FROM article_markings/);
  assert.match(DB.calls.at(-1).sql, /DELETE FROM marked_terms/);
});
~~~

Also test: existing global pending term creates only a new article source; duplicate source is idempotent; removing the last source deletes pending; removing one of two sources preserves pending; userId is bound everywhere.

- [ ] **Step 2: Verify failure**

Run: node --test tests/markings-api.test.js

Expected: missing marking handler and appendMeaning.

- [ ] **Step 3: Implement endpoints**

~~~text
GET    /api/marked-terms
DELETE /api/marked-terms/:termId
POST   /api/articles/:articleId/markings
DELETE /api/articles/:articleId/markings/:markingId
POST   /api/marked-terms/:termId/add-to-word
~~~

Create input:

~~~json
{
  "selectedText": "take part in",
  "normalizedText": "take part in",
  "contextSentence": "Students take part in class."
}
~~~

Recompute normalization, confirm the term occurs in the owned article, infer word/phrase by internal whitespace, reuse/create global pending, and insert the explicit source idempotently.

Article-marking DELETE removes only the requested article source and deletes the pending row only when it has no remaining sources. Global marked-term DELETE verifies ownership, deletes every article_markings row for that pending ID, then deletes the marked_terms row.

- [ ] **Step 4: Implement merge/new conversion**

Conversion input:

~~~json
{
  "zh": "部署",
  "lemma": "deploy",
  "example": "They deployed the service.",
  "stress": "de-PLOY",
  "strategy": "merge",
  "targetWordId": "existing-word-id"
}
~~~

When same-lemma cards exist and no resolution is supplied, return 409 LEMMA_EXISTS with candidates. Merge verifies target ownership, inserts the form, appends a non-duplicate Chinese meaning with ；, retains the target example, converts all source rows from marked_term_id to word_id, and deletes pending. New creates a separate card and form, converts sources, and deletes pending.

- [ ] **Step 5: Route, test, and commit**

Run: npm run test:all

Expected: all ownership, duplicate, cleanup, conflict, merge, and new-card tests PASS.

~~~powershell
git add src/index.js src/markings-api.js tests/markings-api.test.js
git commit -m "feat: add global article marking workflow"
~~~

---

### Task 8: Implement Progress and Statistics APIs

**Files:**
- Create: src/progress-api.js
- Create: src/stats-api.js
- Create: tests/progress-api.test.js
- Modify: src/index.js

**Interfaces:**
- Consumes: owned article and unique client event IDs.
- Produces: latest position, idempotent aggregate events, and per-article statistics.

- [ ] **Step 1: Write failing idempotency tests**

~~~js
test('duplicate event does not increment twice', async () => {
  const DB = createFakeDb({ first: [{ id: 'a1' }, { id: 'event-1' }] });
  const request = new Request('https://app/api/articles/a1/progress/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'event-1', type: 'read_complete', amount: 1 })
  });
  const response = await handleProgressApi(
    request, { DB }, '/api/articles/a1/progress/events', 'u1'
  );
  assert.equal(response.status, 200);
  assert.equal(DB.calls.some(call => /read_count = read_count \+/.test(call.sql)), false);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/progress-api.test.js

Expected: missing progress handler.

- [ ] **Step 3: Implement contracts**

~~~text
PATCH /api/articles/:articleId/progress
POST  /api/articles/:articleId/progress/events
GET   /api/article-stats
~~~

PATCH accepts lastPositionRatio, clamps to 0..1, and upserts without changing counters.

POST accepts { id, type, amount }. active_ms must be an integer from 1 through 60000. Count events require amount 1. Insert the unique event first; update aggregate only when the insert changes one row. read_complete also sets completed to 1.

Statistics list articles by creation time and reports stored reading aggregates plus explicit total/pending/converted counts from article_markings.

- [ ] **Step 4: Route and test**

Run: npm run test:all

Expected: PASS; duplicate IDs do not increment; every query binds userId.

- [ ] **Step 5: Commit**

~~~powershell
git add src/index.js src/progress-api.js src/stats-api.js tests/progress-api.test.js
git commit -m "feat: add article progress statistics"
~~~

---

### Task 9: Build Navigation and Article Library UI

**Files:**
- Create: public/api.js
- Create: public/routes.js
- Create: public/words-view.js
- Create: public/articles-view.js
- Modify: public/app.js
- Modify: public/styles.css
- Expand: tests/static-shell.test.js

**Interfaces:**
- Consumes: auth boot, current word state, article CRUD.
- Produces: top modules words/articles and article pages library/pending/stats/reader.

- [ ] **Step 1: Write a failing route test**

~~~js
test('article reader hash is parsed', async () => {
  const { parseHashRoute } = await import('../public/routes.js');
  assert.deepEqual(parseHashRoute('#/articles/reader/a1'), {
    module: 'articles', page: 'reader', id: 'a1'
  });
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/static-shell.test.js

Expected: parseHashRoute is not exported.

- [ ] **Step 3: Implement API wrapper and app coordinator**

~~~js
export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.error || '请求失败', response.status, data.code, data);
  }
  return data;
}
~~~

routes.js exports a DOM-free parseHashRoute function. app.js owns auth, theme, route, top navigation, and mount/unmount. words-view receives { root, api, speech }. articles-view receives { root, api, navigate }.

- [ ] **Step 4: Implement list and form**

Cards show title, optional author/source, creation time, progress state, edit, and delete. Form fields are title, body, author, source, notes with inline errors. Edit save asks preserve or reset statistics and sends resetProgress. Delete requires confirmation. Use textContent for user content and event delegation with data-action.

- [ ] **Step 5: Browser check and commit**

Run npm run test:all and wrangler dev.

Expected: current word flows work; article create/edit/delete works; form survives API errors; 320px and desktop do not overflow.

~~~powershell
git add public/api.js public/routes.js public/app.js public/words-view.js public/articles-view.js public/styles.css tests/static-shell.test.js
git commit -m "feat: add article library navigation"
~~~

---

### Task 10: Build Reader and Pending Organizer

**Files:**
- Create: public/reader-view.js
- Create: public/pending-view.js
- Modify: public/app.js
- Modify: public/styles.css
- Expand: tests/text.test.js

**Interfaces:**
- Consumes: article detail, text helpers, marking/conversion API.
- Produces: safe sentence DOM, two highlight states, selection action bar, word lookup, article-local unmark, and global pending list.

- [ ] **Step 1: Add a failing state-priority test**

~~~js
test('word state wins over identical pending state', () => {
  const [match] = findTermMatches('Deploy now.', [
    { id: 'p1', normalizedText: 'deploy', status: 'pending' },
    { id: 'w1', normalizedText: 'deploy', status: 'word', payload: { zh: '部署' } }
  ]);
  assert.equal(match.status, 'word');
  assert.equal(match.id, 'w1');
});
~~~

- [ ] **Step 2: Verify failure and implement priority**

Run: node --test tests/text.test.js

Expected before fix: pending or duplicate result. Expected after fix: PASS.

- [ ] **Step 3: Render safe interactive text**

Build nodes with createElement and textContent. Sentences get data-sentence-index. Matches get pc-term-pending or pc-term-word. Never perform regex replacement into innerHTML.

On pointer release, map selection endpoints to sentences and call validateSelection. Show actions only for valid selection. Place near the range on desktop and in-flow on narrow screens.

- [ ] **Step 4: Implement popovers and conversion**

Pending click offers 加入记词本 and, only for a current-article source, 取消本篇标记. Word click displays original, forms, all matched Chinese meanings, and pronunciation.

Conversion requires Chinese, preloads stored context sentence, accepts optional original and stress, and handles 409 LEMMA_EXISTS with candidate merge/new choices. Explain merge policy: append Chinese, retain old example.

Global pending page provides conversion and one “取消标记” operation that removes all explicit sources and the global pending row after confirmation. It does not ask the user to select individual source articles.

- [ ] **Step 5: Verify flows and commit**

Check: valid/cross-sentence selection, longest phrase, automatic versus explicit source, conversion style change, multi-meaning lookup, unmark, and word deletion restoration.

~~~powershell
git add public/app.js public/reader-view.js public/pending-view.js public/styles.css public/lib/text.js tests/text.test.js
git commit -m "feat: add interactive article reader"
~~~

---

### Task 11: Implement Speech

**Files:**
- Create: public/lib/speech.js
- Create: tests/speech.test.js
- Modify: public/words-view.js
- Modify: public/reader-view.js

**Interfaces:**
- Consumes: speechSynthesis, SpeechSynthesisUtterance, sentence array.
- Produces: speakOnce, load, startAt, pause, resume, stop, setRate, current sentence events, and completion coverage.

- [ ] **Step 1: Write failing coverage tests**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechController } from '../public/lib/speech.js';

function createFakeSpeech() {
  let active = null;
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    getVoices: () => [{ name: 'US', lang: 'en-US' }],
    speak(utterance) { active = utterance; utterance.onstart?.(); },
    cancel() { active = null; },
    pause() {},
    resume() {}
  };
  return {
    dependencies: { speechSynthesis, Utterance },
    finishAll() {
      while (active) {
        const finished = active;
        active = null;
        finished.onend?.();
      }
    }
  };
}

test('starting at sentence two of five counts as eighty percent', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two', 'three', 'four', 'five']);
  controller.startAt(1);
  fake.finishAll();
  assert.deepEqual(controller.getCompletion(), {
    reachedEnd: true, coverage: 0.8, counted: true
  });
});

test('starting at sentence three of five does not count', () => {
  const fake = createFakeSpeech();
  const controller = createSpeechController(fake.dependencies);
  controller.load(['one', 'two', 'three', 'four', 'five']);
  controller.startAt(2);
  fake.finishAll();
  assert.equal(controller.getCompletion().counted, false);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/speech.test.js

Expected: missing controller.

- [ ] **Step 3: Implement sentence sequencing**

Voice preference:

~~~js
const voice = voices.find(item => /^en-US$/i.test(item.lang))
  || voices.find(item => /^en/i.test(item.lang))
  || null;
~~~

Use one utterance per sentence. onend records the index and advances. Pause/resume delegate to the engine. Rate change restarts the current sentence without double-counting. stop clears state without completion.

- [ ] **Step 4: Integrate all entry points**

Word and selected phrase use speakOnce. Sentence click speaks one sentence unless the target is a term/control. Toolbar supports play/pause/resume/stop, startAt, and current sentence class pc-sentence-speaking. Its native range input has min=0.5, max=1.5, step=0.5, value=1.0 and calls setRate on input. Missing speech API disables controls with a Chinese explanation.

- [ ] **Step 5: Test and commit**

Run: npm run test:all

Expected: PASS; interrupted, stopped, errored, or under-80% sessions do not count.

~~~powershell
git add public/lib/speech.js public/words-view.js public/reader-view.js tests/speech.test.js
git commit -m "feat: add article speech controls"
~~~

---

### Task 12: Implement Reading Session, Retry Queue, and Statistics UI

**Files:**
- Create: public/lib/reading-session.js
- Create: tests/reading-session.test.js
- Create: public/stats-view.js
- Modify: public/reader-view.js
- Modify: public/app.js
- Modify: public/styles.css

**Interfaces:**
- Consumes: position ratio, visibility, interaction time, speech completion, progress API.
- Produces: active-time deltas up to 60000 ms, top-to-bottom events, position saves, local retry queue, and per-article stats.

- [ ] **Step 1: Write failing session tests**

~~~js
test('active time stops after sixty seconds idle', () => {
  let time = 0;
  const session = createReadingSession({ now: () => time, idleMs: 60_000 });
  session.setVisible(true);
  session.interact();
  time = 30_000;
  assert.equal(session.flushActiveMs(), 30_000);
  time = 100_000;
  assert.equal(session.flushActiveMs(), 30_000);
});

test('completion requires top before bottom', () => {
  const session = createReadingSession({ now: () => 0 });
  assert.equal(session.updatePosition(1).readCompleted, false);
  session.updatePosition(0);
  assert.equal(session.updatePosition(1).readCompleted, true);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test tests/reading-session.test.js

Expected: missing module.

- [ ] **Step 3: Implement state and persistence**

Expose:

~~~js
{
  setVisible(visible),
  interact(),
  updatePosition(ratio),
  flushActiveMs(),
  markReadAloudComplete(),
  snapshot()
}
~~~

Clamp ratio. Arm at ratio <= 0.01, complete at >= 0.99, re-arm only after returning to top. Accrue time only while visible and within idle window.

Persist position at a fixed interval, visibilitychange, and route unmount. Split time into <= 60000 ms events with crypto.randomUUID.

After the reader renders the complete article, restore the saved last_position_ratio once. Suppress scroll-derived completion while applying that initial position so reopening near the end never counts as a new full read.

Store failures in localStorage key pc-progress-queue. Retry FIFO at boot, online, and after a successful progress request. Remove only after acknowledgement.

- [ ] **Step 4: Build stats page**

Render one article row/card with title, complete reads, formatted active time, explicit total, pending, converted, and full read-aloud count. Do not add totals, charts, search, filter, or tags.

- [ ] **Step 5: Verify and commit**

Check middle opening does not complete; top-to-bottom does; one-minute idle pauses; hidden page flushes/stops; failures retry once; statistics do not double-count.

~~~powershell
git add public/lib/reading-session.js public/reader-view.js public/stats-view.js public/app.js public/styles.css tests/reading-session.test.js
git commit -m "feat: track article practice progress"
~~~

---

### Task 13: Polish, Document, and Verify the Full Story

**Files:**
- Modify: public/styles.css
- Modify: public/app.js
- Modify: public/articles-view.js
- Modify: public/reader-view.js
- Modify: public/pending-view.js
- Modify: public/stats-view.js
- Modify: README.md
- Modify tests only when a discovered regression first receives a reproducing test.

**Interfaces:**
- Consumes: Tasks 1-12.
- Produces: release-ready responsive workflow with documented operations and no known regression.

- [ ] **Step 1: Add persistent inline errors**

~~~js
export function renderInlineError(container, message) {
  const error = document.createElement('div');
  error.className = 'pc-inline-error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  container.prepend(error);
  return () => error.remove();
}
~~~

Use for article save/delete, mark/unmark, conversion, hard progress failures, and stats load. Preserve form values. Failed optimistic mark/unmark restores prior state.

- [ ] **Step 2: Finish responsive accessibility**

Verify semantic buttons and labels, dialog focus return, visible focus, aria-live speech status, role=alert errors. At 320px selection actions are in flow and no control overflows. On desktop, text stays single-column and popovers remain inside viewport.

- [ ] **Step 3: Update README**

Document:

~~~powershell
wrangler d1 migrations apply phonetic_cards_db --local
npm run test:all
wrangler dev
~~~

Explain article creation, explicit versus automatic sources, pending conversion, original/forms, reading count, active time, read-aloud count, and online-only scope.

- [ ] **Step 4: Run automated verification**

~~~powershell
npm run test:all
wrangler d1 migrations apply phonetic_cards_db --local --persist-to .wrangler/test-state/article-practice
git diff --check
git status --short
~~~

Expected: tests PASS, migrations succeed, no whitespace errors, and only intentional files differ. wrangler.toml remains local and unstaged.

- [ ] **Step 5: Run the complete browser story**

1. Log in and confirm current learning and self-test.
2. Create two short articles containing one shared word and an overlapping phrase.
3. Mark the phrase in article A; confirm automatic highlight but no explicit count in B.
4. Confirm in B, then remove from B; A keeps the global pending item.
5. Convert it to a new word with Chinese and automatic sentence example.
6. Add another form, trigger same-original conflict, merge, confirm Chinese appends and old example remains.
7. Click in both articles and confirm original, forms, meanings, and US-English-preferred speech.
8. Read top to bottom, wait over 60 seconds idle, and confirm counts/time.
9. Start full speech early enough to cover 80%, reach the end, and confirm one count.
10. Edit and test preserve/reset statistics.
11. Delete an article and then the word card; confirm cleanup and normal text.
12. Open stats and verify each per-article metric.

Expected: all behavior matches the approved specification and browser console has no uncaught errors.

- [ ] **Step 6: Commit final polish**

~~~powershell
git add public src tests README.md package.json migrations/0003_article_practice.sql
git commit -m "docs: document article practice workflow"
~~~

- [ ] **Step 7: Invoke completion skills**

Use superpowers:verification-before-completion, then superpowers:requesting-code-review. Fix verified issues by first adding a reproducing test. When checks pass, use superpowers:finishing-a-development-branch for merge, PR, or local handoff.
