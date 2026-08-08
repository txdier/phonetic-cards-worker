import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('mobile fixes leave action icons in the pointer hit-test path', async () => {
  const css = await readFile(new URL('../public/mobile-fixes.css', import.meta.url), 'utf8');
  assert.doesNotMatch(
    css,
    /\[data-action\][^{]*svg[^}]*pointer-events:\s*none/,
    'iOS must deliver the icon pointer event so the owning button can activate'
  );
});

test('iOS install dialog is opaque, viewport constrained, and safe-area aware', async () => {
  const css = await readFile(new URL('../public/mobile-fixes.css', import.meta.url), 'utf8');
  const dialog = css.match(/\.pc-install-dialog\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(dialog, /position:\s*fixed/);
  assert.match(dialog, /background:\s*var\(--install-dialog-bg\)\s*!important/);
  assert.match(dialog, /max-height:\s*calc\([\s\S]*100dvh/);
  assert.match(dialog, /env\(safe-area-inset-top\)/);
  assert.match(dialog, /env\(safe-area-inset-bottom\)/);
  assert.match(dialog, /overflow:\s*auto/);
  assert.match(css, /\.pc-install-dialog::backdrop\s*\{[^}]*background:\s*rgb\(0 0 0 \/ 72%\)\s*!important/s);
});
