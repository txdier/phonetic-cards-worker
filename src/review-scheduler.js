import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating
} from 'ts-fsrs';

const scheduler = fsrs(generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false
}));

export const REVIEW_RATINGS = Object.freeze([
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy
]);

export function createReviewCard(now = new Date()) {
  return createEmptyCard(now);
}

export function scheduleReview(card, rating, reviewedAt = new Date()) {
  if (!REVIEW_RATINGS.includes(rating)) {
    throw Object.assign(new Error('rating must be between 1 and 4'), {
      status: 400,
      code: 'INVALID_REVIEW_RATING'
    });
  }
  const result = scheduler.next(card, reviewedAt, rating);
  return { rating, ...result };
}

export function cardFromRow(row) {
  return {
    due: new Date(row.due_at),
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    elapsed_days: Number(row.elapsed_days),
    scheduled_days: Number(row.scheduled_days),
    learning_steps: Number(row.learning_steps),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    state: Number(row.state),
    last_review: row.last_review_at == null ? undefined : new Date(row.last_review_at)
  };
}

export function cardToRow(card) {
  return {
    due_at: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review_at: card.last_review?.getTime() ?? null
  };
}
