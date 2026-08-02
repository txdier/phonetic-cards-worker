const CACHE_NAME = 'phonetic-cards-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/api.js',
  '/articles-view.js',
  '/pending-view.js',
  '/reader-view.js',
  '/routes.js',
  '/stats-view.js',
  '/words-view.js',
  '/lib/aloud-checkpoint.js',
  '/lib/connectivity.js',
  '/lib/dom.js',
  '/lib/floating-panel.js',
  '/lib/media-session.js',
  '/lib/pwa-install.js',
  '/lib/reader-preferences.js',
  '/lib/reading-session.js',
  '/lib/sleep-timer.js',
  '/lib/speech.js',
  '/lib/text.js',
  '/lib/tts-player.js',
  '/lib/tts-preferences.js',
  '/lib/word-display.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
