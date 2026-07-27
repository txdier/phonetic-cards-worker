import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewCard, scheduleReview } from '../src/review-scheduler.js';

test('FSRS schedules all four ratings from a fixed review time', () => {
  const reviewedAt = new Date('2026-07-27T00:00:00.000Z');
  const card = createReviewCard(reviewedAt);

  const outcomes = [1, 2, 3, 4].map(rating =>
    scheduleReview(card, rating, reviewedAt)
  );

  assert.deepEqual(outcomes.map(outcome => outcome.rating), [1, 2, 3, 4]);
  assert.ok(outcomes.every(outcome => outcome.card.due instanceof Date));
  assert.ok(outcomes.every(outcome => outcome.card.due > reviewedAt));
  assert.ok(outcomes[0].card.due <= outcomes[1].card.due);
  assert.ok(outcomes[1].card.due <= outcomes[2].card.due);
  assert.ok(outcomes[2].card.due <= outcomes[3].card.due);
});
