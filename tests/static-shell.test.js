import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index loads external application assets', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /type="module" src="\/app\.js"/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /<script>\s*\(function/);
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1\.0">/);
});

test('app registers the service worker and renders a dedicated offline shell', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /registerServiceWorker/);
  assert.match(app, /data-role['"]?,\s*['"]offline-shell/);
  assert.match(app, /window\.addEventListener\(['"]online['"]/);
  assert.match(app, /安装应用/);
  assert.match(app, /Safari 分享 → 添加到主屏幕/);
});

test('styles protect small screens, touch targets, focus, and reduced motion', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /\.pc-play\s*\{[^}]*width:\s*(?:4[0-9]|[5-9][0-9])px;[^}]*height:\s*(?:4[0-9]|[5-9][0-9])px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pc-play\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pc-form\s+(?:input|:is\(input,\s*textarea\))[^{]*\{[^}]*font-size:\s*16px/);
  assert.match(css, /\.pc-reader-sentence:focus-visible\s*\{[^}]*outline:[^}]*var\(--teal\)/);
  assert.doesNotMatch(css, /#pc-root\s+button\s*,/);
  assert.match(css, /\.pc-inline-error\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  const selectionReading = css.match(/\.pc-selection-reading\s*\{([^}]*)\}/)?.[1];
  assert.ok(selectionReading, 'selection reading group should have a responsive style rule');
  assert.doesNotMatch(selectionReading, /(?:^|[;\s])(?:(?:width|min-width)\s*:|position\s*:\s*(?:fixed|absolute)|(?:left|right)\s*:)/);
});

test('mobile sleep timer input prevents focus zoom', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\),\s*\(max-width:\s*900px\)\s+and\s+\(pointer:\s*coarse\)\s*\{[\s\S]*?\.pc-sleep-timer-custom\s*\{[^}]*font-size:\s*16px/
  );
});

test('desktop sleep timer uses measured coordinates with a scroll-safe viewport limit', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const panel = css.match(/\.pc-sleep-timer-panel\s*\{([^}]*)\}/)?.[1];
  assert.ok(panel);
  assert.match(panel, /left:\s*var\(--sleep-timer-left,\s*12px\)/);
  assert.match(panel, /top:\s*var\(--sleep-timer-top,\s*12px\)/);
  assert.match(panel, /max-height:\s*calc\(100dvh\s*-\s*24px\)/);
  assert.match(panel, /overflow-y:\s*auto/);
  assert.doesNotMatch(panel, /310px/);
});

test('article reader uses normal-flow paragraphs with themed typography', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /family=Atkinson\+Hyperlegible:wght@400;700/);
  assert.match(css, /\.pc-reader-text\s*\{[^}]*font-family:\s*'Atkinson Hyperlegible',\s*'Noto Sans SC'/);
  assert.match(css, /\.pc-reader-text\s*\{[^}]*white-space:\s*pre-line/);
  assert.match(css, /\.pc-reader-paragraph\s*\{[^}]*margin:\s*0/);
  assert.match(css, /\.pc-reader-paragraph\s*\+\s*\.pc-reader-paragraph\s*\{[^}]*margin-top:\s*1em/);
});

test('reader settings use theme tokens, responsive measure, and accessible controls', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.pc-reader-content\s*\{[^}]*max-width:\s*var\(--reader-max-width,\s*760px\)/);
  assert.match(css, /\.pc-reader-settings-trigger\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
  const panel = css.match(/\.pc-reader-settings-panel\s*\{([^}]*)\}/)?.[1];
  assert.ok(panel);
  assert.match(panel, /background:\s*var\(--bg-panel\)/);
  assert.match(panel, /border:\s*1px solid var\(--line\)/);
  assert.match(panel, /color:\s*var\(--ink\)/);
  assert.match(panel, /overflow-y:\s*auto/);
  assert.match(css, /\.pc-reader-settings-choice\[aria-pressed="true"\]\s*\{[^}]*var\(--teal\)/);
});

test('tag checkboxes render as compact centered color chips', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const choice = css.match(/\.pc-tag-choice\s*\{([^}]*)\}/)?.[1];
  const checkbox = css.match(/\.pc-tag-choice input\[type="checkbox"\]\s*\{([^}]*)\}/)?.[1];
  const checked = css.match(/\.pc-tag-choice:has\(input:checked\)\s*\{([^}]*)\}/)?.[1];

  assert.ok(choice, 'tag choices should have a style rule');
  assert.match(choice, /min-height:\s*32px/);
  assert.match(choice, /padding:\s*4px 11px/);
  assert.match(choice, /align-items:\s*center/);
  assert.match(choice, /justify-content:\s*center/);
  assert.match(choice, /border-radius:\s*999px/);
  assert.match(choice, /max-width:\s*100%/);
  assert.match(choice, /white-space:\s*nowrap/);
  assert.match(choice, /overflow:\s*hidden/);
  assert.match(choice, /cursor:\s*pointer/);
  assert.ok(checkbox, 'native tag checkboxes should have a visually hidden rule');
  assert.match(checkbox, /position:\s*absolute/);
  assert.match(checkbox, /clip-path:\s*inset\(50%\)/);
  assert.ok(checked, 'checked tag choices should have a color state');
  assert.match(checked, /border-color:\s*var\(--teal\)/);
  assert.match(checked, /background:\s*color-mix\(in srgb,\s*var\(--teal\)\s+16%,\s*var\(--bg-panel\)\)/);
  assert.match(checked, /color:\s*color-mix\(in srgb,\s*var\(--teal\)\s+78%,\s*var\(--ink\)\)/);
  assert.deepEqual(
    checked.split(';').map((declaration) => declaration.trim().match(/^([\w-]+)\s*:/)?.[1]).filter(Boolean).sort(),
    ['border-color', 'background', 'color'].sort(),
    'checked tag choices should use only color declarations'
  );
  assert.doesNotMatch(css, /\.pc-tag-choice(?::has\(input:checked\))?::before\s*\{/);
  assert.match(css, /\.pc-tag-choice:has\(input:focus-visible\)\s*\{[^}]*outline:/);
  assert.match(css, /\.pc-form input:not\(\[type="checkbox"\]\),\s*\.pc-form textarea/);
  assert.match(css, /\.pc-form label:not\(\.pc-tag-choice\)\s*\{/);
});

test('checked tag chip colors meet WCAG contrast in both shipped themes', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const themeRules = [
    css.match(/#pc-root\s*\{([^}]*)\}/)?.[1],
    css.match(/#pc-root\.pc-light\s*\{([^}]*)\}/)?.[1],
  ];
  const toRgb = (hex) => hex.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16));
  const token = (rule, name) => rule.match(new RegExp(`${name}:\\s*(#[\\da-fA-F]{6})`))?.[1];
  const mix = (foreground, background, percentage) => foreground.map(
    (value, index) => Math.round(value * percentage + background[index] * (1 - percentage))
  );
  const luminance = (color) => color.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (first, second) => {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  };

  for (const rule of themeRules) {
    assert.ok(rule, 'each shipped theme should define a token rule');
    const teal = toRgb(token(rule, '--teal'));
    const ink = toRgb(token(rule, '--ink'));
    const panel = toRgb(token(rule, '--bg-panel'));
    assert.ok(contrast(mix(teal, ink, 0.78), mix(teal, panel, 0.16)) >= 4.5);
  }
});

test('disabled tag chips do not advertise interaction', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.pc-tag-choice:has\(input:disabled\)\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:/);
  assert.match(css, /\.pc-tag-choice:not\(:has\(input:disabled\)\):hover\s*\{/);
  assert.match(css, /\.pc-tag-choice:not\(:has\(input:disabled\)\):active\s*\{/);
});

test('reader popovers become safe-area bottom sheets on phones and coarse tablets', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const responsiveQuery = css.match(
    /@media\s*\(max-width:\s*640px\)\s*,\s*\(max-width:\s*900px\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\s*\}/
  )?.[1];

  assert.ok(responsiveQuery, 'phone and coarse-tablet reader popovers should share a media query');
  assert.match(
    responsiveQuery,
    /\.pc-selection-action\s*,\s*\.pc-term-popover\.pc-reader-popover\s*\{[^}]*position:\s*fixed/
  );
  assert.match(responsiveQuery, /bottom:\s*0/);
  assert.match(responsiveQuery, /left:\s*0/);
  assert.match(responsiveQuery, /right:\s*0/);
  assert.match(responsiveQuery, /max-height:\s*70dvh/);
  assert.match(responsiveQuery, /overflow-y:\s*auto/);
  assert.match(responsiveQuery, /padding-bottom:\s*calc\([^;]*env\(safe-area-inset-bottom\)[^;]*\)/);
  assert.match(responsiveQuery, /border-radius:\s*[^;]+\s+[^;]+\s+0\s+0/);
  assert.doesNotMatch(responsiveQuery, /position:\s*static/);
});

test('reader popovers visually distinguish marked and saved terms', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.pc-reader-popover\[data-term-state="marked"\]\s+\.pc-reader-popover-ribbon\s*\{[^}]*background:\s*var\(--amber\)/);
  assert.match(css, /\.pc-reader-popover\[data-term-state="saved"\]\s+\.pc-reader-popover-ribbon\s*\{[^}]*background:\s*var\(--teal\)/);
  assert.match(css, /\.pc-reader-popover-status-marked\s*\{[^}]*var\(--amber\)/);
  assert.match(css, /\.pc-reader-popover-status-saved\s*\{[^}]*var\(--teal\)/);
});

test('long-reading capsule is fixed, safe-area aware, compact, and accessible', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const capsule = css.match(/\.pc-floating-speech\s*\{([^}]*)\}/)?.[1];
  const action = css.match(/\.pc-floating-speech-action\s*\{([^}]*)\}/)?.[1];
  const phoneAndCoarseTablet = css.match(
    /@media\s*\(max-width:\s*640px\)\s*,\s*\(max-width:\s*900px\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\s*@media\s*\(max-width:\s*380px\)/
  )?.[1];

  assert.ok(capsule);
  assert.match(capsule, /position:\s*fixed/);
  assert.match(capsule, /left:\s*50%/);
  assert.match(capsule, /safe-area-inset-bottom/);
  assert.match(capsule, /border-radius:\s*999px/);
  assert.ok(action);
  assert.match(action, /min-height:\s*44px/);
  assert.match(action, /background:\s*transparent/);
  assert.match(css, /\.pc-floating-speech-action:focus-visible/);
  assert.match(css, /\.pc-reader-start-selecting\s+\.pc-reader-sentence\s*\{[^}]*outline/);
  assert.match(css, /\.pc-reader-start-selecting\s+\.pc-reader-sentence:focus-visible/);
  assert.match(css, /\.pc-reader-start-hint\s*\{[^}]*color:\s*var\(--ink-dim\)/);
  assert.ok(phoneAndCoarseTablet);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-entry\s*\{[^}]*display:\s*grid/);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-entry\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-copy\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-copy\s*\{[^}]*overflow:\s*hidden/);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-copy\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-entry \.pc-btn-ghost\s*\{[^}]*min-height:\s*44px/);
  assert.match(phoneAndCoarseTablet, /\.pc-aloud-resume-entry \.pc-btn-ghost\s*\{[^}]*white-space:\s*nowrap/);
});

test('mobile speech capsule keeps five complete controls on one row', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const capsule = css.match(/\.pc-floating-speech\s*\{([^}]*)\}/)?.[1];
  const action = css.match(/\.pc-floating-speech-action\s*\{([^}]*)\}/)?.[1];
  const phoneAndCoarseTablet = css.match(
    /@media\s*\(max-width:\s*640px\)\s*,\s*\(max-width:\s*900px\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\s*@media\s*\(max-width:\s*380px\)/
  )?.[1];

  assert.ok(capsule);
  assert.match(capsule, /display:\s*grid/);
  assert.match(capsule, /grid-template-columns:\s*repeat\(5,\s*minmax\(44px,\s*auto\)\)/);
  assert.match(capsule, /max-width:\s*calc\(100vw\s*-\s*24px\)/);
  assert.ok(action);
  assert.match(action, /min-width:\s*44px/);
  assert.match(action, /min-height:\s*44px/);
  assert.match(action, /touch-action:\s*manipulation/);
  assert.match(action, /white-space:\s*nowrap/);
  assert.match(css, /\.pc-floating-speech-action:disabled\s*\{[^}]*opacity:\s*\.45/);
  assert.ok(phoneAndCoarseTablet);
  assert.match(phoneAndCoarseTablet, /\.pc-floating-speech\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(44px,\s*1fr\)\)/);
  assert.match(phoneAndCoarseTablet, /\.pc-floating-speech-label\s*\{[^}]*display:\s*none/);
  assert.match(phoneAndCoarseTablet, /\.pc-floating-speech-action\s*\{[^}]*min-width:\s*44px/);
  assert.match(phoneAndCoarseTablet, /\.pc-floating-speech-action\s+svg\s*\{[^}]*width:\s*18px/);
  assert.doesNotMatch(phoneAndCoarseTablet, /overflow-x:\s*(?:auto|scroll)/);
  const topSpeechActions = css.match(
    /\.pc-reader-speech\s+\[data-action="speech-primary"\][\s\S]*?\{([^}]*)\}/
  )?.[1];
  assert.ok(topSpeechActions);
  assert.match(topSpeechActions, /min-width:\s*44px/);
  assert.match(topSpeechActions, /min-height:\s*44px/);
});

test('navigation and word filters follow the responsive content layout', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const filters = css.match(/\.pc-library-filters\s*\{([^}]*)\}/)?.[1];

  assert.ok(filters, 'word filters should have a style rule');
  assert.match(filters, /max-width:\s*920px/);
  assert.match(filters, /margin:\s*0\s+auto\s+18px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-account-actions\s*\{[^}]*order:\s*-1/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-account-actions\s*\{[^}]*width:\s*100%/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-module-tabs\s*\{[^}]*width:\s*100%/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-username\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-username\s*\{[^}]*text-overflow:\s*ellipsis/);
});

test('word card actions and relation dialog stay responsive', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const cardTop = css.match(/\.pc-card-top\s*\{([^}]*)\}/)?.[1];
  const cardActions = css.match(/\.pc-card-top-actions\s*\{([^}]*)\}/)?.[1];
  const relationDialog = css.match(/\.pc-relation-dialog\s*\{([^}]*)\}/)?.[1];
  const relationForm = css.match(/\.pc-relation-dialog form\s*\{([^}]*)\}/)?.[1];
  const relationRow = css.match(/\.pc-relation-row\s*\{([^}]*)\}/)?.[1];
  const relationSection = css.match(/\.pc-relation-section\s*\{([^}]*)\}/)?.[1];
  const relationSearch = css.match(/\.pc-relation-search-field\s*\{([^}]*)\}/)?.[1];
  const relationPair = css.match(/\.pc-relation-pair\s*\{([^}]*)\}/)?.[1];
  const relationActions = css.match(/\.pc-relation-form-actions\s*\{([^}]*)\}/)?.[1];
  const relationSearchButton = css.match(/\.pc-relation-search-button\s*\{([^}]*)\}/)?.[1];

  assert.ok(cardTop, 'word card header should have a style rule');
  assert.ok(cardActions, 'word card actions should have a style rule');
  assert.ok(relationDialog, 'relation dialog should have a style rule');
  assert.ok(relationForm, 'relation form should have a style rule');
  assert.ok(relationRow, 'relation row should have a style rule');
  assert.ok(relationSection);
  assert.ok(relationSearch);
  assert.ok(relationPair);
  assert.ok(relationActions);
  assert.ok(relationSearchButton);
  assert.match(cardTop, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+96px/);
  assert.match(cardActions, /grid-template-columns:\s*repeat\(2,\s*44px\)/);
  assert.match(cardActions, /gap:\s*8px/);
  assert.match(cardActions, /position:\s*absolute/);
  assert.match(cardActions, /top:\s*0/);
  assert.match(cardActions, /right:\s*0/);
  assert.match(
    css,
    /\.pc-card-top-actions\s*>\s*\.pc-card-icon-button:last-of-type\s*\{[^}]*border-radius:\s*0\s+11px\s+0\s+7px/
  );
  assert.match(relationDialog, /max-height:/);
  assert.match(relationDialog, /overflow-y:\s*auto/);
  assert.match(relationForm, /display:\s*grid/);
  assert.match(relationRow, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(relationSection, /border:\s*1px\s+solid\s+var\(--line\)/);
  assert.match(relationSearch, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+96px/);
  assert.match(relationPair, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(relationSearchButton, /height:\s*44px/);
  assert.match(relationActions, /justify-content:\s*flex-end/);
  assert.match(css, /\.pc-relation-form-actions \.pc-btn-primary\s*\{[^}]*height:\s*44px/);
  assert.match(css, /\.pc-relation-delete\s*\{[^}]*min-height:\s*36px/);
  assert.match(css, /\.pc-word-phrase\s*\{[^}]*white-space:\s*normal/);
  assert.match(css, /\.pc-word-long\s*\{[^}]*font-size:\s*17px/);
  assert.match(css, /\.pc-word-extra-long\s*\{[^}]*font-size:\s*15px/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-relation-search-field,\s*\.pc-relation-pair\s*\{[^}]*grid-template-columns:\s*1fr/
  );
});

test('pending organizer uses the responsive three two one column ledger', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const pendingList = css.match(/\.pc-pending-list\s*\{([^}]*)\}/)?.[1];
  const pendingRow = css.match(/\.pc-pending-row\s*\{([^}]*)\}/)?.[1];
  const pendingTerm = css.match(/\.pc-pending-term\s*\{([^}]*)\}/)?.[1];
  assert.ok(pendingList, 'pending list should have a style rule');
  assert.ok(pendingRow, 'pending row should have a style rule');
  assert.ok(pendingTerm, 'pending term should have a style rule');
  assert.match(pendingList, /display:\s*grid/);
  assert.match(pendingList, /width:\s*100%/);
  assert.match(pendingList, /max-width:\s*920px/);
  assert.match(pendingList, /grid-template-columns:\s*1fr/);
  assert.match(pendingList, /margin:\s*0\s+auto/);
  assert.match(pendingList, /gap:\s*14px/);
  assert.doesNotMatch(pendingList, /background:/);
  assert.doesNotMatch(pendingList, /border:/);
  assert.match(pendingRow, /background:\s*var\(--bg-panel\)/);
  assert.match(pendingRow, /border:\s*1px\s+solid\s+var\(--line\)/);
  assert.match(pendingRow, /border-radius:\s*12px/);
  assert.match(css, /@media\s*\(min-width:\s*700px\)[\s\S]*?\.pc-pending-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(min-width:\s*1100px\)[\s\S]*?\.pc-pending-list\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(pendingTerm, /font-size:\s*16px/);
  assert.match(pendingTerm, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(pendingTerm, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(pendingTerm, /overflow:\s*hidden/);
  assert.doesNotMatch(pendingTerm, /white-space:\s*nowrap/);
  assert.match(css, /#pc-root\s+button\.pc-pending-action\s*\{[^}]*min-height:\s*32px/);
  assert.match(css, /@media\s*\(max-width:\s*699px\)[\s\S]*?\.pc-pending-action\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media\s*\(max-width:\s*699px\)[\s\S]*?\.pc-pending-actions\s*\{[^}]*gap:\s*8px/);
});

test('article reader hash is parsed and malformed hashes are safe', async () => {
  const { parseHashRoute } = await import('../public/routes.js');
  assert.deepEqual(parseHashRoute('#/articles/reader/a1'), {
    module: 'articles', page: 'reader', id: 'a1'
  });
  assert.deepEqual(parseHashRoute('#/articles/library'), {
    module: 'articles', page: 'library'
  });
  assert.deepEqual(parseHashRoute('#/articles'), {
    module: 'articles', page: 'library'
  });
  assert.deepEqual(parseHashRoute('#/words/review'), {
    module: 'words', page: 'review'
  });
  assert.deepEqual(parseHashRoute('#/%E0%A4%A'), {
    module: 'words', page: 'library'
  });
  assert.deepEqual(parseHashRoute('#/unknown/place'), {
    module: 'words', page: 'library'
  });
});

test('api wrapper preserves headers and only adds JSON content type for a body', async () => {
  const { api } = await import('../public/api.js');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await api('/without-body', { headers: { 'x-test': 'kept' } });
    await api('/with-body', {
      method: 'POST',
      body: JSON.stringify({ title: 'One' }),
      headers: { 'x-test': 'kept', 'content-type': 'application/custom+json' }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(new Headers(calls[0].init.headers).has('content-type'), false);
  assert.equal(new Headers(calls[0].init.headers).get('x-test'), 'kept');
  assert.equal(new Headers(calls[1].init.headers).get('content-type'), 'application/custom+json');
  assert.equal(new Headers(calls[1].init.headers).get('x-test'), 'kept');
});

test('api wrapper reports JSON and non-JSON failures as ApiError', async () => {
  const { api, ApiError } = await import('../public/api.js');
  const originalFetch = globalThis.fetch;
  let response = new Response(JSON.stringify({ error: 'bad title', code: 'BAD_TITLE' }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  });
  globalThis.fetch = async () => response;
  try {
    await assert.rejects(api('/json-error'), error =>
      error instanceof ApiError &&
      error.status === 400 &&
      error.code === 'BAD_TITLE' &&
      error.message === 'bad title'
    );
    response = new Response('upstream unavailable', { status: 502 });
    await assert.rejects(api('/text-error'), error =>
      error instanceof ApiError &&
      error.status === 502 &&
      error.message === 'upstream unavailable'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('application extracts views and keeps article user content out of HTML strings', async () => {
  const [app, wordsView, articlesView] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/words-view.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/articles-view.js', import.meta.url), 'utf8')
  ]);
  assert.match(app, /from ['"]\.\/api\.js['"]/);
  assert.match(app, /from ['"]\.\/routes\.js['"]/);
  assert.match(app, /from ['"]\.\/words-view\.js['"]/);
  assert.match(app, /from ['"]\.\/articles-view\.js['"]/);
  assert.match(app, /setUnauthorizedHandler/);
  assert.match(app, /if\s*\(!user\.username\)\s*throw/);
  assert.match(wordsView, /distinctForms/);
  assert.match(wordsView, /maskWordForms/);
  assert.match(wordsView, /primaryWord/);
  assert.match(wordsView, /data-action=["']judge["']/);
  assert.match(wordsView, /data-action=["']play["']/);
  assert.match(articlesView, /\.textContent\s*=/);
  assert.match(articlesView, /data-action/);
  assert.match(articlesView, /form\.noValidate\s*=\s*true/);
  assert.doesNotMatch(articlesView, /innerHTML\s*=.*(?:article\.|form\.)/);
});
