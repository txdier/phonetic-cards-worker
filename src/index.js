import { handleLogin, handleLogout, handleMe, requireUser } from './auth.js';
import { handleArticlesApi } from './articles-api.js';
import { jsonResponse } from './http.js';
import { handleMarkingsApi } from './markings-api.js';
import { handleProgressApi } from './progress-api.js';
import { handleReviewsApi } from './reviews-api.js';
import { handleStatsApi } from './stats-api.js';
import { handleTtsApi } from './tts-api.js';
import { handleTranslationApi } from './translation-api.js';
import { handleWordLibraryApi } from './word-library-api.js';
import { handleWordsApi } from './words-api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }
    if (path === '/api/logout' && request.method === 'POST') {
      return handleLogout();
    }
    if (path === '/api/me' && request.method === 'GET') {
      return handleMe(request, env);
    }

    if (path.startsWith('/api/')) {
      const userId = await requireUser(request, env);
      if (!userId) {
        return jsonResponse({ error: 'unauthorized' }, { status: 401 });
      }
      try {
        if (
          /^\/api\/articles\/[a-zA-Z0-9-]+\/progress(?:\/events)?$/.test(path)
        ) {
          return await handleProgressApi(request, env, path, userId);
        }
        if (path === '/api/article-stats') {
          return await handleStatsApi(request, env, path, userId);
        }
        if (
          path === '/api/reviews/due' ||
          /^\/api\/words\/[a-zA-Z0-9-]+\/reviews$/.test(path)
        ) {
          return await handleReviewsApi(request, env, path, userId);
        }
        if (
          path === '/api/tts/usage' ||
          /^\/api\/tts\/words\/[a-zA-Z0-9-]+$/.test(path) ||
          /^\/api\/tts\/articles\/[a-zA-Z0-9-]+\/sentences\/\d+$/.test(path)
        ) {
          return await handleTtsApi(request, env, path, userId);
        }
        if (
          path === '/api/translations/word' ||
          path === '/api/translations/selection' ||
          /^\/api\/articles\/[a-zA-Z0-9-]+\/translation$/.test(path)
        ) {
          return await handleTranslationApi(request, env, path, userId);
        }
        if (
          path === '/api/tags' ||
          path.startsWith('/api/tags/') ||
          path === '/api/word-stats' ||
          path === '/api/export' ||
          /^\/api\/words\/[a-zA-Z0-9-]+\/(?:tags|relations)(?:\/[a-zA-Z0-9-]+)?$/.test(path)
        ) {
          return await handleWordLibraryApi(request, env, path, userId);
        }
        if (
          path === '/api/marked-terms' ||
          path.startsWith('/api/marked-terms/') ||
          /^\/api\/articles\/[a-zA-Z0-9-]+\/markings(?:\/[a-zA-Z0-9-]+)?$/.test(path)
        ) {
          return await handleMarkingsApi(request, env, path, userId);
        }
        if (path === '/api/articles' || /^\/api\/articles\/[a-zA-Z0-9-]+$/.test(path)) {
          return await handleArticlesApi(request, env, path, userId);
        }
        return await handleWordsApi(request, env, path, userId);
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: error.status || 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
