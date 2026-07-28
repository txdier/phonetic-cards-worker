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

test('word relation controls stay within narrow cards', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const relationForm = css.match(/\.pc-relation-panel form\s*\{([^}]*)\}/)?.[1];
  const relationRow = css.match(/\.pc-relation-row\s*\{([^}]*)\}/)?.[1];

  assert.ok(relationForm, 'relation form should have a style rule');
  assert.ok(relationRow, 'relation row should have a style rule');
  assert.match(relationForm, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(relationRow, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-relation-panel form,\s*\.pc-relation-row\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test('pending organizer uses the responsive three two one column ledger', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const pendingList = css.match(/\.pc-pending-list\s*\{([^}]*)\}/)?.[1];
  const pendingTerm = css.match(/\.pc-pending-term\s*\{([^}]*)\}/)?.[1];
  assert.ok(pendingList, 'pending list should have a style rule');
  assert.ok(pendingTerm, 'pending term should have a style rule');
  assert.match(pendingList, /display:\s*grid/);
  assert.match(pendingList, /width:\s*100%/);
  assert.match(pendingList, /max-width:\s*920px/);
  assert.match(pendingList, /grid-template-columns:\s*1fr/);
  assert.match(pendingList, /margin:\s*0\s+auto/);
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
