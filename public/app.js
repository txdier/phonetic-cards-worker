import { api, setUnauthorizedHandler } from './api.js';
import { createArticlesView } from './articles-view.js';
import { createPendingView } from './pending-view.js';
import { createReaderView } from './reader-view.js';
import { hashForRoute, parseHashRoute } from './routes.js';
import { createSpeechController } from './lib/speech.js';
import { createTtsPlayer } from './lib/tts-player.js';
import { createProgressQueue, progressQueueKey, sendProgressItem } from './lib/reading-session.js';
import { createWordsView } from './words-view.js';
import { createStatsView } from './stats-view.js';

const root = document.getElementById('pc-root');
let currentUsername = null;
let unmountView = null;
let progressQueue = null;
let lightMode = false;
try { lightMode = localStorage.getItem('pc-theme') === 'light'; } catch { /* storage may be disabled */ }
root.classList.toggle('pc-light', lightMode);

const speech = createSpeechController({
  speechSynthesis: window.speechSynthesis,
  Utterance: window.SpeechSynthesisUtterance
});
const tts = createTtsPlayer({
  fetch: typeof window.fetch === 'function'
    ? window.fetch.bind(window)
    : globalThis.fetch?.bind(globalThis),
  Audio: window.Audio,
  URL: window.URL,
  fallback: speech
});
let progressStorage = null;
try { progressStorage = globalThis.localStorage; } catch { /* storage may be disabled */ }
window.addEventListener('beforeunload', () => speech.cleanup());
window.addEventListener('online', () => progressQueue?.retry());

function navigate(route) {
  const hash = hashForRoute(route);
  if (location.hash === hash) mountRoute();
  else location.hash = hash;
}

function renderLogin(message = '') {
  unmountView?.();
  unmountView = null;
  root.replaceChildren();
  const header = document.createElement('div');
  header.className = 'pc-header pc-login-header';
  const eyebrow = document.createElement('div'); eyebrow.className = 'pc-eyebrow'; eyebrow.textContent = 'PHONETIC CARDS · 语音卡片';
  const title = document.createElement('div'); title.className = 'pc-title'; title.textContent = '登录';
  const sub = document.createElement('div'); sub.className = 'pc-sub'; sub.textContent = '登录后可在任意设备同步学习内容';
  header.append(eyebrow, title, sub);
  const wrap = document.createElement('div'); wrap.className = 'pc-login-wrap';
  const form = document.createElement('form'); form.className = 'pc-login-card';
  form.innerHTML = '<div class="pc-login-error" role="alert" hidden></div><label for="login-user">用户名</label><input id="login-user" autocomplete="username"><label for="login-pass">密码</label><input type="password" id="login-pass" autocomplete="current-password"><button class="pc-btn-primary pc-login-submit">登录</button>';
  const error = form.querySelector('.pc-login-error');
  error.textContent = message;
  error.hidden = !message;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const username = form.querySelector('#login-user').value.trim();
    const password = form.querySelector('#login-pass').value;
    if (!username || !password) { renderLogin('请输入用户名和密码'); return; }
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      await boot();
    } catch (requestError) {
      renderLogin(requestError.message || '登录失败');
    }
  });
  wrap.append(form); root.append(header, wrap);
}

function disconnectProgressAndRenderLogin(message = '') {
  const previousQueue = progressQueue;
  progressQueue = null;
  renderLogin(message);
  previousQueue?.retry();
}

function mountRoute() {
  if (!currentUsername) return;
  unmountView?.();
  unmountView = null;
  const route = parseHashRoute(location.hash);
  root.replaceChildren();
  const shell = document.createElement('div'); shell.className = 'pc-app-shell';
  const top = document.createElement('nav'); top.className = 'pc-topnav'; top.setAttribute('aria-label', '主要功能');
  const modules = document.createElement('div'); modules.className = 'pc-module-tabs';
  for (const item of [{ module: 'words', label: '词库' }, { module: 'articles', label: '文章练习' }]) {
    const button = document.createElement('button');
    const active = route.module === item.module;
    button.className = `pc-module-tab${active ? ' active' : ''}`;
    if (active) button.setAttribute('aria-current', 'page');
    button.textContent = item.label;
    button.addEventListener('click', () => navigate({ module: item.module, page: 'library' }));
    modules.append(button);
  }
  const account = document.createElement('div'); account.className = 'pc-account-actions';
  const username = document.createElement('span'); username.className = 'pc-username'; username.textContent = currentUsername;
  const theme = document.createElement('button'); theme.className = 'pc-theme-toggle'; theme.textContent = lightMode ? '深色' : '浅色'; theme.setAttribute('aria-label', '切换主题');
  theme.addEventListener('click', () => {
    lightMode = !lightMode; root.classList.toggle('pc-light', lightMode);
    try { localStorage.setItem('pc-theme', lightMode ? 'light' : 'dark'); } catch { /* ignore */ }
    theme.textContent = lightMode ? '深色' : '浅色';
  });
  const logout = document.createElement('button'); logout.className = 'pc-theme-toggle'; logout.textContent = '退出登录';
  logout.addEventListener('click', async () => {
    unmountView?.();
    unmountView = null;
    await progressQueue?.retry();
    try { await api('/api/logout', { method: 'POST' }); } catch { /* local logout still proceeds */ }
    currentUsername = null;
    progressQueue = null;
    renderLogin();
  });
  account.append(username, theme, logout); top.append(modules, account); shell.append(top);
  if (route.module === 'words') {
    const subnav = document.createElement('nav'); subnav.className = 'pc-article-nav'; subnav.setAttribute('aria-label', '词库页面');
    for (const item of [{ page: 'library', label: '词库' }, { page: 'review', label: '复习' }, { page: 'settings', label: '设置' }]) {
      const button = document.createElement('button');
      const active = route.page === item.page;
      button.className = `pc-article-nav-link${active ? ' active' : ''}`;
      if (active) button.setAttribute('aria-current', 'page');
      button.textContent = item.label;
      button.addEventListener('click', () => navigate({ module: 'words', page: item.page }));
      subnav.append(button);
    }
    shell.append(subnav);
  }
  if (route.module === 'articles') {
    const subnav = document.createElement('nav'); subnav.className = 'pc-article-nav'; subnav.setAttribute('aria-label', '文章练习页面');
    for (const item of [{ page: 'library', label: '文章库' }, { page: 'pending', label: '待整理' }, { page: 'stats', label: '统计' }]) {
      const button = document.createElement('button');
      const active = route.page === item.page;
      button.className = `pc-article-nav-link${active ? ' active' : ''}`;
      if (active) button.setAttribute('aria-current', 'page');
      button.textContent = item.label;
      button.addEventListener('click', () => navigate({ module: 'articles', page: item.page })); subnav.append(button);
    }
    shell.append(subnav);
  }
  const viewRoot = document.createElement('main'); viewRoot.className = 'pc-view-root'; shell.append(viewRoot); root.append(shell);
  if (route.module === 'words') {
    unmountView = createWordsView({ root: viewRoot, api, speech, tts, page: route.page });
  } else if (route.page === 'reader') {
    unmountView = createReaderView({ root: viewRoot, api, navigate, speech, tts, progressQueue, articleId: route.id });
  } else if (route.page === 'pending') {
    unmountView = createPendingView({ root: viewRoot, api });
  } else if (route.page === 'stats') {
    unmountView = createStatsView({ root: viewRoot, api });
  } else {
    unmountView = createArticlesView({ root: viewRoot, api, navigate, route });
  }
}

async function boot() {
  try {
    const user = await api('/api/me');
    if (!user.username) throw new Error('unauthorized');
    currentUsername = user.username;
    progressQueue = createProgressQueue({
      storage: progressStorage,
      key: progressQueueKey(currentUsername),
      send: item => sendProgressItem(api, item)
    });
    progressQueue.retry();
    if (!location.hash) history.replaceState(null, '', '#/words');
    mountRoute();
  } catch {
    currentUsername = null;
    disconnectProgressAndRenderLogin();
  }
}

window.addEventListener('hashchange', mountRoute);
setUnauthorizedHandler(() => {
  currentUsername = null;
  disconnectProgressAndRenderLogin();
});
boot();
