function isStandalone(windowRef, navigatorRef) {
  return windowRef.matchMedia?.('(display-mode: standalone)').matches === true
    || navigatorRef?.standalone === true;
}

function isIos(navigatorRef) {
  return /iPad|iPhone|iPod/.test(navigatorRef?.userAgent || '');
}

export function createPwaInstallController({
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
  onChange = () => {}
} = {}) {
  let promptEvent = null;
  let installed = isStandalone(windowRef, navigatorRef);

  const beforeInstall = event => {
    event.preventDefault();
    promptEvent = event;
    onChange();
  };
  const appInstalled = () => {
    installed = true;
    promptEvent = null;
    onChange();
  };
  windowRef.addEventListener?.('beforeinstallprompt', beforeInstall);
  windowRef.addEventListener?.('appinstalled', appInstalled);

  return {
    mode() {
      if (installed) return 'hidden';
      if (promptEvent) return 'prompt';
      return isIos(navigatorRef) ? 'ios' : 'hidden';
    },
    async install() {
      if (promptEvent) {
        const activePrompt = promptEvent;
        promptEvent = null;
        await activePrompt.prompt();
        const choice = await activePrompt.userChoice;
        if (choice?.outcome === 'accepted') installed = true;
        onChange();
        return choice || { outcome: 'dismissed' };
      }
      if (!installed && isIos(navigatorRef)) return { outcome: 'instructions' };
      return { outcome: 'unavailable' };
    },
    dispose() {
      windowRef.removeEventListener?.('beforeinstallprompt', beforeInstall);
      windowRef.removeEventListener?.('appinstalled', appInstalled);
    }
  };
}

export function registerServiceWorker(navigatorRef = globalThis.navigator, windowRef = globalThis.window) {
  if (!navigatorRef?.serviceWorker) return;
  windowRef.addEventListener('load', () => {
    navigatorRef.serviceWorker.register('/sw.js').catch(() => {
      // Installation is optional; the online application remains available.
    });
  });
}
