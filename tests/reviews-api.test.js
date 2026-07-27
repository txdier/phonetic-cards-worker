import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReviewsApi } from '../src/reviews-api.js';
import { createFakeDb } from './helpers/fake-db.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

test('review submission is idempotent and advances the FSRS state once', async t => {
  const DB = createSqliteDb();
  t.after(() => DB.close());
  seedWord(DB);
  const now = new Date('2026-07-27T00:00:00.000Z');
  const body = { reviewId: 'review-1', rating: 3, version: 0 };

  const first = await handleReviewsApi(
    jsonRequest('/api/words/w1/reviews', 'POST', body),
    { DB }, '/api/words/w1/reviews', 'u1', { now: () => now }
  );
  const repeated = await handleReviewsApi(
    jsonRequest('/api/words/w1/reviews', 'POST', body),
    { DB }, '/api/words/w1/reviews', 'u1', { now: () => now }
  );

  assert.equal(first.status, 200);
  assert.deepEqual(await repeated.json(), await first.json());
  assert.equal(DB.get(
    'SELECT COUNT(*) AS count FROM word_review_logs WHERE word_id = ?', 'w1'
  ).count, 1);
  assert.equal(DB.get(
    'SELECT reps FROM word_review_state WHERE word_id = ?', 'w1'
  ).reps, 1);
});

test('due review endpoint returns only owned due cards', async t => {
  const DB = createSqliteDb();
  t.after(() => DB.close());
  seedWord(DB);
  const response = await handleReviewsApi(
    new Request('https://app/api/reviews/due?limit=20'),
    { DB }, '/api/reviews/due', 'u1',
    { now: () => new Date('2026-07-27T00:00:00.000Z') }
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).words.map(word => word.id), ['w1']);
});

test('review submission rejects a stale concurrent state version', async () => {
  const DB = createFakeDb({
    first: [
      null,
      {
        word_id: 'w1', user_id: 'u1', due_at: 0,
        stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
        learning_steps: 0, reps: 0, lapses: 0, state: 0,
        last_review_at: null, version: 4
      }
    ],
    run: [
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 0 } }
    ]
  });
  const response = await handleReviewsApi(
    jsonRequest('/api/words/w1/reviews', 'POST', {
      reviewId: 'stale-review', rating: 3, version: 4
    }),
    { DB }, '/api/words/w1/reviews', 'u1',
    { now: () => new Date('2026-07-27T00:00:00.000Z') }
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'REVIEW_CONFLICT');
});

function seedWord(DB) {
  DB.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, NULL, ?)'
  ).bind('u1', 'user-one', 1).run();
  DB.prepare(`
    INSERT INTO words
      (id, user_id, en, lemma, zh, example, stress, familiarity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).bind('w1', 'u1', 'confirm', 'confirm', '确认', 'Please confirm it.', 'con-FIRM', 1).run();
  DB.prepare(`
    INSERT INTO word_review_state
      (word_id, user_id, due_at, stability, difficulty, elapsed_days,
       scheduled_days, learning_steps, reps, lapses, state, last_review_at,
       version, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 0, ?, ?)
  `).bind('w1', 'u1', 0, 1, 1).run();
}

function jsonRequest(path, method, body) {
  return new Request(`https://app${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
