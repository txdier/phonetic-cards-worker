import { renderInlineError } from './lib/dom.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function formatActiveTime(milliseconds) {
  let seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分`);
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join(' ');
}

export function createStatsView({ root, api }) {
  let mounted = true;
  root.replaceChildren(element('div', 'pc-empty', '加载中…'));

  api('/api/article-stats').then(rows => {
    if (!mounted) return;
    root.replaceChildren();
    const header = element('header', 'pc-header');
    header.append(element('div', 'pc-eyebrow', 'ARTICLE PRACTICE'), element('h1', 'pc-title', '练习统计'));
    root.append(header);
    if (!rows.length) {
      root.append(element('div', 'pc-empty', '暂无文章统计'));
      return;
    }
    const list = element('div', 'pc-stats-list');
    for (const row of rows) {
      const card = element('article', 'pc-card pc-stats-card');
      card.dataset.articleId = row.id;
      card.append(element('h2', 'pc-article-title', row.title));
      const metrics = element('dl', 'pc-stats-metrics');
      for (const [label, value] of [
        ['完整阅读', `${row.read_count || 0}次`],
        ['有效时长', formatActiveTime(row.active_read_ms)],
        ['显式标记', row.marking_count || 0],
        ['待处理', row.pending_marking_count || 0],
        ['已转入词本', row.converted_marking_count || 0],
        ['完整朗读', `${row.full_read_aloud_count || 0}次`]
      ]) {
        const metric = element('div');
        metric.append(element('dt', '', label), element('dd', '', String(value)));
        metrics.append(metric);
      }
      card.append(metrics);
      list.append(card);
    }
    root.append(list);
  }).catch(error => {
    if (!mounted) return;
    root.replaceChildren();
    renderInlineError(root, error.message || '统计加载失败');
  });

  return () => { mounted = false; };
}
