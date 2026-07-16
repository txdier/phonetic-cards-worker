import { jsonResponse } from './http.js';

export async function handleStatsApi(request, env, path, userId) {
  if (path === '/api/article-stats' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT
        a.id, a.title, a.author, a.source, a.created_at,
        COALESCE(p.last_position_ratio, 0) AS last_position_ratio,
        COALESCE(p.completed, 0) AS completed,
        COALESCE(p.read_count, 0) AS read_count,
        COALESCE(p.active_read_ms, 0) AS active_read_ms,
        COALESCE(p.full_read_aloud_count, 0) AS full_read_aloud_count,
        COUNT(m.id) AS marking_count,
        SUM(CASE WHEN m.marked_term_id IS NOT NULL THEN 1 ELSE 0 END)
          AS pending_marking_count,
        SUM(CASE WHEN m.word_id IS NOT NULL THEN 1 ELSE 0 END)
          AS converted_marking_count
      FROM articles a
      LEFT JOIN article_progress p
        ON p.article_id = a.id AND p.user_id = a.user_id
      LEFT JOIN article_markings m
        ON m.article_id = a.id AND m.user_id = a.user_id
      WHERE a.user_id = ?
      GROUP BY
        a.id, a.title, a.author, a.source, a.created_at,
        p.last_position_ratio, p.completed, p.read_count,
        p.active_read_ms, p.full_read_aloud_count
      ORDER BY a.created_at DESC
    `).bind(userId).all();
    return jsonResponse(results);
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}
