const DEFAULT_ROUTE = Object.freeze({ module: 'words', page: 'library' });
const ARTICLE_PAGES = new Set(['library', 'pending', 'stats']);

export function parseHashRoute(hash = '') {
  let parts;
  try {
    parts = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { ...DEFAULT_ROUTE };
  }
  if (parts[0] === 'words' && (parts.length === 1 || parts[1] === 'library')) {
    return { ...DEFAULT_ROUTE };
  }
  if (parts[0] !== 'articles') return { ...DEFAULT_ROUTE };
  const page = parts[1] || 'library';
  if (parts.length === 1) return { module: 'articles', page: 'library' };
  if (ARTICLE_PAGES.has(page) && parts.length === 2) return { module: 'articles', page };
  if (page === 'reader' && parts.length === 3 && parts[2]) {
    return { module: 'articles', page, id: parts[2] };
  }
  return { ...DEFAULT_ROUTE };
}

export function hashForRoute(route) {
  if (route.module === 'articles') {
    const id = route.id ? `/${encodeURIComponent(route.id)}` : '';
    return `#/articles/${route.page || 'library'}${id}`;
  }
  return '#/words';
}
