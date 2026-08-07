# Task 6 Report: Progressive Article Translation Scheduler

## Outcome

Implemented first-batch-priority progressive article translation and integrated it with the reader.

- Added `createArticleTranslationScheduler({ requestBatch, onBatch, onError })` with `start`, `suspend`, and `invalidate` lifecycle methods.
- A missing batch 0 is the only initial request; later batches start only after its success.
- Later work is limited to two active requests.
- Every successful batch state is delivered to `onBatch` immediately.
- Suspension prevents new requests while allowing valid in-flight results to render.
- Resume schedules only missing, non-active batches and preserves batch-0 priority even when it is still in flight.
- Invalidation makes stale success and failure callbacks inert.
- The reader now uses `PUT /api/articles/:id/translation/batches/:index` with `sourceHash`, `rulesVersion`, and `refresh`.
- The reader retains missing progressive plan metadata, renders full mode immediately, replaces its translation state after each batch, suspends when leaving full mode, and invalidates on reload and cleanup.
- Removed the temporary whole-article PUT busy-state path.

## Files

- `public/lib/article-translation-scheduler.js`
- `public/reader-view.js`
- `tests/article-translation-scheduler.test.js`
- `tests/reader-pending-dom.test.js`

## TDD Evidence

Initial scheduler RED:

```text
node --test tests/article-translation-scheduler.test.js
FAIL ERR_MODULE_NOT_FOUND: public/lib/article-translation-scheduler.js
tests 1, pass 0, fail 1
```

Initial scheduler GREEN:

```text
node --test tests/article-translation-scheduler.test.js
tests 3, pass 3, fail 0
```

Reader integration RED:

```text
node --test --test-name-pattern="reader schedules progressive" tests/reader-pending-dom.test.js
tests 1, pass 0, fail 1
Expected batch-0 call; actual calls: []
```

The reader integration became GREEN after replacing the legacy whole-article trigger with the scheduler. The first complete focused run then exposed legacy endpoint/busy-state tests, which were converted to the progressive batch contract.

Self-review race RED:

```text
node --test --test-name-pattern="first-batch priority across" tests/article-translation-scheduler.test.js
tests 1, pass 0, fail 1
Expected started [0]; actual [0, 1]
```

This covered suspend/resume while batch 0 itself remained in flight. The gate now treats an active batch 0 as unresolved first-batch work.

Independent-review RED:

```text
node --test --test-name-pattern="synchronous first-batch failure" tests/article-translation-scheduler.test.js
tests 1, pass 0, fail 1
Expected started [0]; actual [0, 1, 2, 3]
```

`pump()` now stops when starting a request fails synchronously, so later work cannot bypass a failed batch 0.

## Final Verification

```text
node --test tests/article-translation-scheduler.test.js
tests 5, pass 5, fail 0

node --test tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js
tests 117, pass 117, fail 0

npm.cmd run test:all
tests 444, pass 444, fail 0

git diff --check
exit 0
```

## Self-review and Independent Review

- Confirmed the required observed ordering `[0, 2, 1, 3]` and maximum concurrency of two.
- Confirmed suspension still delivers in-flight `onBatch` callbacks without starting queued work.
- Confirmed resume neither duplicates completed/active batches nor releases later work before an active batch 0 succeeds.
- Confirmed reload and cleanup invalidate both stale successes and stale failures.
- Confirmed the reader sends the exact batch request body and immediately replaces visible progressive state.
- Independent review found the synchronous-throw batch-0 bypass; it was reproduced RED and fixed GREEN before commit.
- `git diff --check` and the exact staged-file review were clean.

## Deferred Concerns

No known Task 6 blocker remains.

Two review observations belong to later tasks in the progressive-translation plan:

- Task 7 owns forced-refresh overlap/supersession semantics, retry, quota stop, and manual continuation.
- Legacy fresh GET responses currently lack progressive `sourceHash`, `rulesVersion`, and `batches`; Task 8 owns additive compatibility metadata and shell integration. Until that metadata exists, a legacy-shaped refresh cannot be progressively scheduled.

No retry/quota styling or recovery UI was added in Task 6.

## Follow-up Review Fixes: Queue Reconciliation and Duplicate Indexes

Two additional independent-review findings were reproduced with controlled deferred tests.

Follow-up RED:

```text
node --test --test-name-pattern="skips queued batches|duplicate batch indexes" tests/article-translation-scheduler.test.js
tests 2, pass 0, fail 2

completed-state reconciliation:
expected started [0]
actual started [0, 1, 2, 3]

duplicate descriptors:
expected started [0, 1, 2]
actual started [0, 0, 1, 1, 2]
```

Root cause: the queue retained the initial server snapshot for its entire run and used batch object identity rather than batch index as its uniqueness boundary.

Fixes:

- Queue construction now canonicalizes batch descriptors by `batch.index`.
- Every dequeue re-checks the current active index set and, for normal non-refresh work, the latest server-completed index set.
- After each successful `onBatch`, normal queued work is reconciled against `result.batches[].completed` before pumping.
- Refresh queues are deliberately excluded from completion reconciliation; refresh supersession remains assigned to Task 7.

Follow-up GREEN and final verification:

```text
node --test --test-name-pattern="skips queued batches|duplicate batch indexes" tests/article-translation-scheduler.test.js
tests 2, pass 2, fail 0

node --test tests/article-translation-scheduler.test.js
tests 7, pass 7, fail 0

node --test tests/article-translation-scheduler.test.js tests/reader-pending-dom.test.js
tests 119, pass 119, fail 0

npm.cmd run test:all
tests 446, pass 446, fail 0

git diff --check
exit 0
```

Follow-up self-review confirmed that duplicate descriptors cannot create concurrent requests for one index or cause one settlement to delete another request's active marker. No new concerns were found; Task 7 refresh supersession remains the only intentionally deferred scheduler behavior from this review cycle.
