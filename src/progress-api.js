import { jsonResponse } from './http.js';

const EVENT_TYPES = new Set([
  'active_ms',
  'read_complete',
  'read_aloud_complete'
]);

export async function handleProgressApi(request, env, path, userId) {
  const patchMatch = path.match(
    /^\/api\/articles\/([a-zA-Z0-9-]+)\/progress$/
  );
  if (patchMatch && request.method === 'PATCH') {
    const articleId = patchMatch[1];
    if (!await findOwnedArticle(env, articleId, userId)) return articleNotFound();

    const body = await parseObjectBody(request);
    const hasAloudIndex = body &&
      Object.prototype.hasOwnProperty.call(body, 'lastAloudSentenceIndex');
    if (
      !body || !isFiniteNumber(body.lastPositionRatio) ||
      (hasAloudIndex && !isValidAloudIndex(body.lastAloudSentenceIndex))
    ) {
      return invalidProgressBody();
    }
    const ratio = Math.max(0, Math.min(1, body.lastPositionRatio));
    const updatedAt = Date.now();
    await env.DB.prepare(`
      INSERT INTO article_progress
        (article_id, user_id, last_position_ratio, completed, read_count,
         active_read_ms, full_read_aloud_count, last_aloud_sentence_index, updated_at)
      VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(article_id) DO UPDATE SET
        last_position_ratio = excluded.last_position_ratio,
        last_aloud_sentence_index = CASE
          WHEN ? = 1 THEN excluded.last_aloud_sentence_index
          ELSE article_progress.last_aloud_sentence_index
        END,
        updated_at = excluded.updated_at
      WHERE article_progress.user_id = excluded.user_id
    `).bind(
      articleId, userId, ratio,
      hasAloudIndex ? body.lastAloudSentenceIndex : null,
      updatedAt, hasAloudIndex ? 1 : 0
    ).run();
    return jsonResponse({ ok: true, last_position_ratio: ratio, updated_at: updatedAt });
  }

  const eventMatch = path.match(
    /^\/api\/articles\/([a-zA-Z0-9-]+)\/progress\/events$/
  );
  if (eventMatch && request.method === 'POST') {
    const articleId = eventMatch[1];
    if (!await findOwnedArticle(env, articleId, userId)) return articleNotFound();

    const event = await parseObjectBody(request);
    if (!isValidEvent(event)) return invalidProgressEvent();

    const createdAt = Date.now();
    const insertEvent = env.DB.prepare(`
      INSERT OR IGNORE INTO article_progress_events
        (id, article_id, user_id, event_type, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      event.id, articleId, userId, event.type, event.amount, createdAt
    );

    const increments = eventIncrements(event);
    const updateAggregate = env.DB.prepare(`
      INSERT INTO article_progress
        (article_id, user_id, last_position_ratio, completed, read_count,
         active_read_ms, full_read_aloud_count, updated_at)
      SELECT ?, ?, 0, ?, ?, ?, ?, ?
      WHERE changes() = 1
      ON CONFLICT(article_id) DO UPDATE SET
        completed = CASE
          WHEN excluded.completed = 1 THEN 1 ELSE article_progress.completed
        END,
        read_count = article_progress.read_count + excluded.read_count,
        active_read_ms = article_progress.active_read_ms + excluded.active_read_ms,
        full_read_aloud_count =
          article_progress.full_read_aloud_count + excluded.full_read_aloud_count,
        updated_at = excluded.updated_at
      WHERE article_progress.user_id = excluded.user_id
    `).bind(
      articleId, userId, increments.completed, increments.readCount,
      increments.activeReadMs, increments.fullReadAloudCount, createdAt
    );
    const [inserted] = await env.DB.batch([insertEvent, updateAggregate]);
    const duplicate = !inserted.meta?.changes;
    return jsonResponse({ ok: true, duplicate });
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}

async function findOwnedArticle(env, articleId, userId) {
  return env.DB.prepare(`
    SELECT id FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
}

async function parseObjectBody(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidAloudIndex(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function isValidEvent(event) {
  if (
    !event || typeof event.id !== 'string' || !event.id.trim() ||
    typeof event.type !== 'string' || !EVENT_TYPES.has(event.type) ||
    !Number.isInteger(event.amount)
  ) return false;
  if (event.type === 'active_ms') {
    return event.amount >= 1 && event.amount <= 60000;
  }
  return event.amount === 1;
}

function eventIncrements(event) {
  return {
    completed: event.type === 'read_complete' ? 1 : 0,
    readCount: event.type === 'read_complete' ? 1 : 0,
    activeReadMs: event.type === 'active_ms' ? event.amount : 0,
    fullReadAloudCount: event.type === 'read_aloud_complete' ? 1 : 0
  };
}

function invalidProgressBody() {
  return jsonResponse(
    { error: 'progress body is invalid', code: 'INVALID_PROGRESS_BODY' },
    { status: 400 }
  );
}

function invalidProgressEvent() {
  return jsonResponse(
    { error: 'progress event is invalid', code: 'INVALID_PROGRESS_EVENT' },
    { status: 400 }
  );
}

function articleNotFound() {
  return jsonResponse(
    { error: 'not found', code: 'ARTICLE_NOT_FOUND' },
    { status: 404 }
  );
}
