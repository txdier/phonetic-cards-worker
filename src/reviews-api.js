import { jsonResponse } from './http.js';
import {
  cardFromRow,
  cardToRow,
  scheduleReview
} from './review-scheduler.js';

export async function handleReviewsApi(
  request,
  env,
  path,
  userId,
  runtime = {}
) {
  const now = runtime.now || (() => new Date());

  if (path === '/api/reviews/due' && request.method === 'GET') {
    const limit = clampLimit(new URL(request.url).searchParams.get('limit'));
    const dueAt = now().getTime();
    const { results: words } = await env.DB.prepare(`
      SELECT
        w.id, w.en, w.lemma, w.zh, w.example, w.stress, w.created_at,
        r.due_at, r.state, r.reps, r.lapses, r.scheduled_days, r.version
      FROM word_review_state r
      JOIN words w ON w.id = r.word_id AND w.user_id = r.user_id
      WHERE r.user_id = ? AND r.due_at <= ?
      ORDER BY r.due_at, w.created_at
      LIMIT ?
    `).bind(userId, dueAt, limit).all();
    const formsByWord = await loadForms(env.DB, userId);
    return jsonResponse({
      words: words.map(word => ({
        ...word,
        lemma: word.lemma || word.en,
        forms: formsByWord.get(word.id) || []
      })),
      now: dueAt
    });
  }

  const reviewMatch = path.match(/^\/api\/words\/([a-zA-Z0-9-]+)\/reviews$/);
  if (!reviewMatch || request.method !== 'POST') {
    return jsonResponse({ error: 'not found' }, { status: 404 });
  }

  const body = await parseObjectBody(request);
  if (
    !body ||
    typeof body.reviewId !== 'string' ||
    !body.reviewId.trim() ||
    body.reviewId.length > 100 ||
    !Number.isInteger(body.version) ||
    body.version < 0 ||
    !Number.isInteger(body.rating) ||
    body.rating < 1 ||
    body.rating > 4
  ) {
    return jsonResponse(
      { error: 'reviewId and rating are required', code: 'INVALID_REVIEW' },
      { status: 400 }
    );
  }

  const wordId = reviewMatch[1];
  const reviewId = body.reviewId.trim();
  const prior = await loadReviewResult(env.DB, reviewId, wordId, userId);
  if (prior) return jsonResponse(prior);

  const row = await env.DB.prepare(`
    SELECT r.*
    FROM word_review_state r
    JOIN words w ON w.id = r.word_id AND w.user_id = r.user_id
    WHERE r.word_id = ? AND r.user_id = ?
  `).bind(wordId, userId).first();
  if (!row) {
    return jsonResponse(
      { error: 'not found', code: 'WORD_NOT_FOUND' },
      { status: 404 }
    );
  }
  if (Number(row.version) !== body.version) {
    return jsonResponse(
      { error: 'review state changed', code: 'REVIEW_CONFLICT' },
      { status: 409 }
    );
  }

  const reviewedAt = now();
  const outcome = scheduleReview(cardFromRow(row), body.rating, reviewedAt);
  const next = cardToRow(outcome.card);
  const result = {
    reviewId,
    wordId,
    rating: body.rating,
    state: next.state,
    dueAt: next.due_at,
    reviewedAt: reviewedAt.getTime(),
    scheduledDays: next.scheduled_days
  };
  const resultJson = JSON.stringify(result);

  try {
    const batch = await env.DB.batch([
      env.DB.prepare(`
        UPDATE word_review_state
        SET due_at = ?, stability = ?, difficulty = ?, elapsed_days = ?,
            scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?,
            state = ?, last_review_at = ?, version = version + 1,
            updated_at = ?
        WHERE word_id = ? AND user_id = ? AND version = ?
      `).bind(
        next.due_at, next.stability, next.difficulty, next.elapsed_days,
        next.scheduled_days, next.learning_steps, next.reps, next.lapses,
        next.state, next.last_review_at, reviewedAt.getTime(),
        wordId, userId, row.version
      ),
      env.DB.prepare(`
        INSERT INTO word_review_logs
          (review_id, word_id, user_id, rating, previous_version, reviewed_at,
           due_at, state, stability, difficulty, scheduled_days, result_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1
      `).bind(
        reviewId, wordId, userId, body.rating, row.version,
        reviewedAt.getTime(), next.due_at, next.state, next.stability,
        next.difficulty, next.scheduled_days, resultJson
      )
    ]);
    if (!batch[0].meta.changes) {
      const repeated = await loadReviewResult(env.DB, reviewId, wordId, userId);
      if (repeated) return jsonResponse(repeated);
      return jsonResponse(
        { error: 'review state changed', code: 'REVIEW_CONFLICT' },
        { status: 409 }
      );
    }
    return jsonResponse(result);
  } catch (error) {
    const repeated = await loadReviewResult(env.DB, reviewId, wordId, userId);
    if (repeated) return jsonResponse(repeated);
    throw error;
  }
}

async function loadReviewResult(DB, reviewId, wordId, userId) {
  const row = await DB.prepare(`
    SELECT result_json FROM word_review_logs
    WHERE review_id = ? AND word_id = ? AND user_id = ?
  `).bind(reviewId, wordId, userId).first();
  return row ? JSON.parse(row.result_json) : null;
}

async function loadForms(DB, userId) {
  const { results } = await DB.prepare(`
    SELECT word_id, form, normalized_form
    FROM word_forms WHERE user_id = ? ORDER BY created_at
  `).bind(userId).all();
  const result = new Map();
  for (const form of results) {
    const list = result.get(form.word_id) || [];
    list.push({ form: form.form, normalized_form: form.normalized_form });
    result.set(form.word_id, list);
  }
  return result;
}

function clampLimit(raw) {
  const value = Number.parseInt(raw || '20', 10);
  return Number.isFinite(value) ? Math.min(20, Math.max(1, value)) : 20;
}

async function parseObjectBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
