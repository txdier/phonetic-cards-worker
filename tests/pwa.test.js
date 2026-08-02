import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manifest describes the installable app and all generated icon sizes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '语音卡片 · Phonetic Cards');
  assert.equal(manifest.short_name, '语音卡片');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#10151c');
  assert.equal(manifest.theme_color, '#e8a33d');
  assert.deepEqual(manifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose })), [
    { src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' }
  ]);
});

test('application shell links the manifest and Apple icon', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon-180\.png"/);
  assert.match(html, /name="theme-color" content="#e8a33d"/);
});

test('service worker precaches the shell while API and cross-origin requests stay network only', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const asset of ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png']) {
    assert.ok(source.includes(`'${asset}'`), `${asset} should be precached`);
  }
  assert.match(source, /url\.origin\s*!==\s*self\.location\.origin/);
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /request\.mode\s*===\s*'navigate'/);
  assert.match(source, /caches\.match\('\/'\)/);
});

test('PWA installer uses the Chromium prompt and iOS instructions', async () => {
  const { createPwaInstallController } = await import('../public/lib/pwa-install.js');
  const listeners = new Map();
  const windowRef = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    matchMedia() { return { matches: false }; }
  };
  const chromium = createPwaInstallController({
    windowRef,
    navigatorRef: { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile' }
  });
  let prompted = 0;
  listeners.get('beforeinstallprompt')({
    preventDefault() {},
    prompt() { prompted += 1; },
    userChoice: Promise.resolve({ outcome: 'accepted' })
  });
  assert.equal(chromium.mode(), 'prompt');
  assert.equal((await chromium.install()).outcome, 'accepted');
  assert.equal(prompted, 1);
  chromium.dispose();

  const ios = createPwaInstallController({
    windowRef,
    navigatorRef: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1' }
  });
  assert.equal(ios.mode(), 'ios');
  assert.deepEqual(await ios.install(), { outcome: 'instructions' });
  ios.dispose();
});

test('connectivity failures are distinguished from authentication failures', async () => {
  const { isConnectivityFailure } = await import('../public/lib/connectivity.js');
  assert.equal(isConnectivityFailure(new TypeError('Failed to fetch'), { onLine: true }), true);
  assert.equal(isConnectivityFailure(new Error('bad password'), { onLine: true }), false);
  assert.equal(isConnectivityFailure(new Error('anything'), { onLine: false }), true);
});
