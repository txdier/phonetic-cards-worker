import { jsonResponse } from './http.js';
import { containsNormalizedTerm } from '../public/lib/text.js';

export async function handleArticlesApi(request, env, path, userId) {
  if (path === '/api/articles' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT
        a.id, a.title, a.author, a.source, a.notes, a.created_at, a.updated_at,
        p.last_position_ratio, p.completed, p.read_count, p.active_read_ms,
        p.full_read_aloud_count, p.updated_at AS progress_updated_at
      FROM articles a
      JOIN article_progress p ON p.article_id = a.id AND p.user_id = a.user_id
      WHERE a.user_id = ?
      ORDER BY a.created_at DESC
    `).bind(userId).all();
    return jsonResponse(results.map(toArticleSummary));
  }

  if (path === '/api/articles' && request.method === 'POST') {
    const body = await request.json();
    if (!isJsonObject(body)) return articleRequiredFields();
    const title = String(body.title || '').trim();
    const articleBody = String(body.body || '').replace(/\r\n/g, '\n').trim();
    if (!title || !articleBody) {
      return articleRequiredFields();
    }

    const now = Date.now();
    const article = {
      id: crypto.randomUUID(),
      title,
      body: articleBody,
      author: String(body.author || '').trim(),
      source: String(body.source || '').trim(),
      notes: String(body.notes || '').trim(),
      created_at: now,
      updated_at: now
    };
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO articles
          (id, user_id, title, body, author, source, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        article.id, userId, article.title, article.body, article.author,
        article.source, article.notes, article.created_at, article.updated_at
      ),
      env.DB.prepare(`
        INSERT INTO article_progress
          (article_id, user_id, last_position_ratio, completed, read_count,
           active_read_ms, full_read_aloud_count, updated_at)
        VALUES (?, ?, 0, 0, 0, 0, 0, ?)
      `).bind(article.id, userId, now)
    ]);
    return jsonResponse({ ...article, progress: zeroProgress(now) }, { status: 201 });
  }

  const articleMatch = path.match(/^\/api\/articles\/([a-zA-Z0-9-]+)$/);
  if (articleMatch && request.method === 'GET') {
    const articleId = articleMatch[1];
    const article = await env.DB.prepare(`
      SELECT
        a.id, a.title, a.body, a.author, a.source, a.notes, a.created_at, a.updated_at,
        p.last_position_ratio, p.completed, p.read_count, p.active_read_ms,
        p.full_read_aloud_count, p.updated_at AS progress_updated_at
      FROM articles a
      JOIN article_progress p ON p.article_id = a.id AND p.user_id = a.user_id
      WHERE a.id = ? AND a.user_id = ?
    `).bind(articleId, userId).first();
    if (!article) return articleNotFound();

    const [{ results: markings }, { results: pendingTerms }, { results: wordRows }] =
      await Promise.all([
        env.DB.prepare(`
          SELECT id, normalized_text, selected_text, context_sentence,
                 marked_term_id, word_id, created_at
          FROM article_markings
          WHERE article_id = ? AND user_id = ?
          ORDER BY created_at
        `).bind(articleId, userId).all(),
        env.DB.prepare(`
          SELECT id, display_text, normalized_text, kind, created_at
          FROM marked_terms
          WHERE user_id = ?
          ORDER BY created_at DESC
        `).bind(userId).all(),
        env.DB.prepare(`
          SELECT
            w.id AS word_id, w.en, w.lemma, w.zh, w.example, w.stress,
            wf.id AS form_id, wf.form, wf.normalized_form
          FROM words w
          LEFT JOIN word_forms wf ON wf.word_id = w.id AND wf.user_id = w.user_id
          WHERE w.user_id = ?
          ORDER BY w.created_at DESC, wf.created_at
        `).bind(userId).all()
      ]);

    return jsonResponse({
      ...toArticleDetail(article),
      markings,
      pending_terms: pendingTerms,
      words: groupWords(wordRows)
    });
  }

  if (articleMatch && request.method === 'PATCH') {
    const articleId = articleMatch[1];
    const body = await request.json();
    if (!isJsonObject(body)) return articleRequiredFields();
    const current = await env.DB.prepare(`
      SELECT id, title, body, author, source, notes, created_at, updated_at
      FROM articles
      WHERE id = ? AND user_id = ?
    `).bind(articleId, userId).first();
    if (!current) return articleNotFound();

    const updated = {
      ...current,
      title: patchText(body, 'title', current.title),
      body: patchText(body, 'body', current.body, true),
      author: patchText(body, 'author', current.author),
      source: patchText(body, 'source', current.source),
      notes: patchText(body, 'notes', current.notes),
      updated_at: Date.now()
    };
    if (!updated.title || !updated.body) {
      return articleRequiredFields();
    }

    const { results: markings } = await env.DB.prepare(`
      SELECT id, normalized_text, marked_term_id, word_id
      FROM article_markings
      WHERE article_id = ? AND user_id = ?
    `).bind(articleId, userId).all();
    const removed = markings.filter(
      marking => !containsNormalizedTerm(updated.body, marking.normalized_text)
    );
    const statements = [
      env.DB.prepare(`
        UPDATE articles
        SET title = ?, body = ?, author = ?, source = ?, notes = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).bind(
        updated.title, updated.body, updated.author, updated.source, updated.notes,
        updated.updated_at, articleId, userId
      ),
      ...removed.map(marking => env.DB.prepare(`
        DELETE FROM article_markings
        WHERE id = ? AND article_id = ? AND user_id = ?
      `).bind(marking.id, articleId, userId))
    ];
    const pendingIds = [...new Set(
      removed.map(marking => marking.marked_term_id).filter(Boolean)
    )];
    for (const pendingId of pendingIds) {
      statements.push(env.DB.prepare(`
        DELETE FROM marked_terms
        WHERE id = ? AND user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM article_markings
            WHERE marked_term_id = ? AND user_id = ?
          )
      `).bind(pendingId, userId, pendingId, userId));
    }

    const resetProgress = body.resetProgress === true;
    if (resetProgress) {
      statements.push(
        env.DB.prepare(`
          UPDATE article_progress
          SET last_position_ratio = 0, completed = 0, read_count = 0,
              active_read_ms = 0, full_read_aloud_count = 0, updated_at = ?
          WHERE article_id = ? AND user_id = ?
        `).bind(updated.updated_at, articleId, userId),
        env.DB.prepare(`
          DELETE FROM article_progress_events
          WHERE article_id = ? AND user_id = ?
        `).bind(articleId, userId)
      );
    }
    await env.DB.batch(statements);
    return jsonResponse({
      ...updated,
      removed_marking_ids: removed.map(marking => marking.id),
      reset_progress: resetProgress
    });
  }

  if (articleMatch && request.method === 'DELETE') {
    const articleId = articleMatch[1];
    const owned = await env.DB.prepare(`
      SELECT id FROM articles WHERE id = ? AND user_id = ?
    `).bind(articleId, userId).first();
    if (!owned) return articleNotFound();

    const { results } = await env.DB.prepare(`
      SELECT DISTINCT marked_term_id
      FROM article_markings
      WHERE article_id = ? AND user_id = ? AND marked_term_id IS NOT NULL
    `).bind(articleId, userId).all();
    const pendingIds = results.map(row => row.marked_term_id);
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM articles WHERE id = ? AND user_id = ?
      `).bind(articleId, userId),
      ...pendingIds.map(pendingId => env.DB.prepare(`
        DELETE FROM marked_terms
        WHERE id = ? AND user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM article_markings
            WHERE marked_term_id = ? AND user_id = ?
          )
      `).bind(pendingId, userId, pendingId, userId))
    ]);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}

function toArticleSummary(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    source: row.source,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    progress: {
      last_position_ratio: row.last_position_ratio,
      completed: row.completed,
      read_count: row.read_count,
      active_read_ms: row.active_read_ms,
      full_read_aloud_count: row.full_read_aloud_count,
      updated_at: row.progress_updated_at
    }
  };
}

function toArticleDetail(row) {
  return { ...toArticleSummary(row), body: row.body };
}

function groupWords(rows) {
  const words = new Map();
  for (const row of rows) {
    let word = words.get(row.word_id);
    if (!word) {
      word = {
        id: row.word_id,
        en: row.en,
        lemma: row.lemma,
        zh: row.zh,
        example: row.example,
        stress: row.stress,
        forms: []
      };
      words.set(row.word_id, word);
    }
    if (row.form_id) {
      word.forms.push({
        id: row.form_id,
        form: row.form,
        normalized_form: row.normalized_form
      });
    }
  }
  return [...words.values()];
}

function zeroProgress(updatedAt) {
  return {
    last_position_ratio: 0,
    completed: 0,
    read_count: 0,
    active_read_ms: 0,
    full_read_aloud_count: 0,
    updated_at: updatedAt
  };
}

function articleNotFound() {
  return jsonResponse(
    { error: '文章不存在', code: 'ARTICLE_NOT_FOUND' },
    { status: 404 }
  );
}

function articleRequiredFields() {
  return jsonResponse(
    { error: '文章标题和正文为必填项', code: 'ARTICLE_REQUIRED_FIELDS' },
    { status: 400 }
  );
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function patchText(body, name, fallback, normalizeLineEndings = false) {
  const value = Object.prototype.hasOwnProperty.call(body, name) ? body[name] : fallback;
  const text = String(value || '');
  return (normalizeLineEndings ? text.replace(/\r\n/g, '\n') : text).trim();
}
