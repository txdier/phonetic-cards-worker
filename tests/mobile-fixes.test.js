import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('action icons never intercept delegated clicks on desktop or mobile', async () => {
  const css = await readFile(new URL('../public/mobile-fixes.css', import.meta.url), 'utf8');
  assert.match(css, /#pc-root\s+\[data-action\]\s+svg\s*,/);
  assert.match(css, /#pc-root\s+\[data-action\]\s+svg\s+\*\s*\{[^}]*pointer-events:\s*none\s*!important/);

  const mediaIndex = css.indexOf('@media (max-width: 768px)');
  const clickRuleIndex = css.indexOf('#pc-root [data-action] svg');
  assert.ok(clickRuleIndex >= 0 && clickRuleIndex < mediaIndex, 'icon click-through must apply on desktop too');
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
