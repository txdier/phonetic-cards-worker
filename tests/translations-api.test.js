import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSessionToken } from '../src/auth.js';
import worker from '../src/index.js';
import {
  generatePlainTranslation,
  TRANSLATION_RULES_VERSION,
  translationFailureResponse
} from '../src/translation-api.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

const SECRET = 'translation-test-secret';

test('strict translation service returns only a validated translation', async () => {
  const value = await generatePlainTranslation({
    AI: { async run() { return { response: '{"translation":"璇戞枃"}' }; } }
  }, 'Translate this sentence.');
  assert.equal(value, '璇戞枃');
  assert.equal(TRANSLATION_RULES_VERSION, 'sentence-v2-fast');
});

test('strict translation service exposes stable format failures', async () => {
  await assert.rejects(
    generatePlainTranslation({
      AI: { async run() { return { response: '瑙ｉ噴锛氳瘧鏂?' }; } }
    }, 'Translate this sentence.'),
    error => error.translationCode === 'TRANSLATION_FORMAT_INVALID'
  );
  assert.equal(
    (await translationFailureResponse({
      translationCode: 'TRANSLATION_FORMAT_INVALID', httpStatus: 502
    }).json()).code,
    'TRANSLATION_FORMAT_INVALID'
  );
});

test('Wrangler example exposes the Workers AI binding', async () => {
  const config = await readFile(new URL('../wrangler.example.toml', import.meta.url), 'utf8');
  assert.match(config, /\[ai\]\s+binding\s*=\s*"AI"/);
});

test('word translation uses the complete example and all fixed translation rules', async () => {
  const calls = [];
  const env = {
    AUTH_SECRET: SECRET,
    DB: { prepare() { throw new Error('word translation must not query D1'); } },
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { choices: [{ message: { content: '{"translation":"部署；调配；展开"}' } }] };
      }
    }
  };
  const response = await worker.fetch(await authenticatedRequest(
    '/api/translations/word', 'POST', {
      text: 'deploy',
      example: 'The team deployed the application before dawn.'
    }
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translation: '部署；调配；展开' });
  assert.equal(calls[0].model, '@cf/zai-org/glm-4.7-flash');
  const messages = calls[0].input.messages.map(message => message.content).join('\n');
  for (const rule of [
    '根据整段上下文翻译', '合理补全', '保留原文的语气、强调、重复、称呼和说话风格',
    '不增加原文没有的信息', '自然的中文表达', '只输出译文'
  ]) assert.match(messages, new RegExp(rule));
  assert.match(messages, /The team deployed the application before dawn\./);
});

test('selection translation uses the full sentence but returns only selected text translation', async () => {
  let prompt = '';
  const env = {
    AUTH_SECRET: SECRET,
    DB: { prepare() { throw new Error('selection translation must not query D1'); } },
    AI: {
      async run(_model, input) {
        prompt = input.messages.at(-1).content;
        return { response: '{"translation":"搞定了"}' };
      }
    }
  };
  const response = await worker.fetch(await authenticatedRequest(
    '/api/translations/selection', 'POST', {
      text: 'nailed it',
      context: 'After three failed attempts, she finally nailed it.'
    }
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translation: '搞定了' });
  assert.match(prompt, /只翻译选中的文本/);
  assert.match(prompt, /After three failed attempts, she finally nailed it\./);
});

test('plain translations reject model explanations outside the strict response shape', async () => {
  const env = {
    AUTH_SECRET: SECRET,
    DB: {},
    AI: { async run() { return { response: '译文如下：{"translation":"部署"}' }; } }
  };
  const response = await worker.fetch(await authenticatedRequest(
    '/api/translations/word', 'POST', { text: 'deploy' }
  ), env);

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'TRANSLATION_FORMAT_INVALID');
});

test('translation endpoints reject invalid and oversized text before calling AI', async () => {
  let calls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB: {},
    AI: { async run() { calls += 1; return { response: 'unexpected' }; } }
  };
  const invalid = await worker.fetch(await authenticatedRequest(
    '/api/translations/word', 'POST', { text: '' }
  ), env);
  const oversized = await worker.fetch(await authenticatedRequest(
    '/api/translations/selection', 'POST', { text: 'a'.repeat(2001), context: 'context' }
  ), env);

  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_TRANSLATION_INPUT');
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, 'TRANSLATION_TOO_LONG');
  assert.equal(calls, 0);
});

test('translation endpoints reject oversized context before calling AI', async () => {
  let calls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB: {},
    AI: { async run() { calls += 1; return { response: '{"translation":"意外调用"}' }; } }
  };
  const word = await worker.fetch(await authenticatedRequest(
    '/api/translations/word', 'POST', { text: 'deploy', example: 'x'.repeat(2001) }
  ), env);
  const selection = await worker.fetch(await authenticatedRequest(
    '/api/translations/selection', 'POST', { text: 'hold on', context: 'x'.repeat(2001) }
  ), env);

  assert.equal(word.status, 413);
  assert.equal(selection.status, 413);
  assert.equal(calls, 0);
});

test('article translation rejects an oversized title before calling AI', async t => {
  const DB = seededArticleDb('Short body.');
  t.after(() => DB.close());
  DB.prepare('UPDATE articles SET title = ? WHERE id = ?').bind('x'.repeat(2001), 'a1').run();
  let calls = 0;
  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'PUT', {}
  ), {
    AUTH_SECRET: SECRET,
    DB,
    AI: { async run() { calls += 1; return { response: '{}' }; } }
  });

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test('translation timeout returns a stable retryable error code', async () => {
  let signal;
  const env = {
    AUTH_SECRET: SECRET,
    DB: {},
    TRANSLATION_TIMEOUT_MS: '1',
    AI: {
      run(_model, _input, options) {
        signal = options?.signal;
        return new Promise(() => {});
      }
    }
  };
  const response = await worker.fetch(await authenticatedRequest(
    '/api/translations/selection', 'POST', { text: 'hold on', context: 'Please hold on.' }
  ), env);

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'TRANSLATION_TIMEOUT');
  assert.equal(signal?.aborted, true);
});

test('article translation migration creates owned cascading storage', () => {
  const DB = createSqliteDb();
  try {
    assert.deepEqual(DB.all('PRAGMA table_info(article_translations)').map(row => row.name), [
      'article_id', 'user_id', 'title_zh', 'paragraphs_json', 'source_hash',
      'model', 'created_at', 'updated_at'
    ]);
  } finally {
    DB.close();
  }
});

test('progressive article translation migration stores metadata and paragraphs independently', () => {
  const DB = createSqliteDb();
  try {
    assert.deepEqual(DB.all('PRAGMA table_info(user_preferences)').map(row => row.name), [
      'user_id', 'tts_preferences_json', 'updated_at'
    ]);
    assert.deepEqual(DB.all('PRAGMA table_info(article_translation_progress)').map(row => row.name), [
      'article_id', 'user_id', 'source_hash', 'rules_version', 'title_zh',
      'model', 'created_at', 'updated_at'
    ]);
    assert.deepEqual(DB.all('PRAGMA table_info(article_translation_paragraphs)').map(row => row.name), [
      'article_id', 'user_id', 'source_hash', 'rules_version', 'paragraph_index',
      'translation_zh', 'model', 'created_at', 'updated_at'
    ]);
  } finally {
    DB.close();
  }
});

test('sentence translation migration creates a user-scoped reusable cache', () => {
  const DB = createSqliteDb();
  try {
    assert.deepEqual(
      DB.all('PRAGMA table_info(sentence_translation_cache)').map(row => row.name),
      [
        'user_id', 'cache_key', 'source_hash', 'context_hash', 'sentence_text',
        'translation_zh', 'model', 'rules_version', 'created_at', 'updated_at'
      ]
    );
    const foreignKeys = DB.all('PRAGMA foreign_key_list(sentence_translation_cache)');
    assert.ok(foreignKeys.some(key => key.table === 'users' && key.on_delete === 'CASCADE'));
  } finally {
    DB.close();
  }
});

test('article translation preserves complete paragraphs and persists only a valid full result', async t => {
  const DB = seededArticleDb('First line.\nStill first paragraph.\n\nSecond paragraph!');
  t.after(() => DB.close());
  const calls = [];
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run(_model, input) {
        calls.push(input);
        return { choices: [{ message: { content: JSON.stringify({
          titleTranslation: '测试文章',
          paragraphs: [
            { index: 0, translation: '第一行。\n仍是第一段。' },
            { index: 1, translation: '第二段！' }
          ]
        }) } }] };
      }
    }
  };

  const put = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'PUT', {}
  ), env);
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.ok(Number.isFinite(saved.updatedAt));
  assert.deepEqual({ ...saved, updatedAt: 0 }, {
    status: 'fresh',
    titleZh: '测试文章',
    paragraphs: [
      { index: 0, translation: '第一行。\n仍是第一段。' },
      { index: 1, translation: '第二段！' }
    ],
    model: '@cf/zai-org/glm-4.7-flash',
    updatedAt: 0
  });
  const prompt = calls[0].messages.at(-1).content;
  assert.match(prompt, /First line\.\\nStill first paragraph\./);
  assert.match(prompt, /Second paragraph!/);

  const get = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env);
  assert.equal(get.status, 200);
  const stored = await get.json();
  assert.equal(stored.status, 'fresh');
  assert.equal(stored.titleZh, '测试文章');
  assert.equal(stored.paragraphs.length, 2);
  assert.equal(calls.length, 1);
});

test('article translation rejects explanatory or extra JSON fields', async t => {
  const DB = seededArticleDb('Only paragraph.');
  t.after(() => DB.close());
  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'PUT', {}
  ), {
    AUTH_SECRET: SECRET,
    DB,
    AI: { async run() { return { response: JSON.stringify({
      titleTranslation: '标题',
      paragraphs: [{ index: 0, translation: '唯一一段。', explanation: 'extra' }]
    }) }; } }
  });

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'TRANSLATION_FORMAT_INVALID');
  assert.equal(DB.get(
    'SELECT article_id FROM article_translations WHERE article_id = ?', 'a1'
  ), null);
});

test('article translation never splits an oversized natural paragraph across batches', async t => {
  const longParagraph = `Start ${'x'.repeat(6100)} end.`;
  const DB = seededArticleDb(`${longParagraph}\n\nShort paragraph.`);
  t.after(() => DB.close());
  const prompts = [];
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run(_model, input) {
        const prompt = input.messages.at(-1).content;
        prompts.push(prompt);
        if (prompt.includes('Start ')) {
          return { response: JSON.stringify({
            titleTranslation: '标题',
            paragraphs: [{ index: 0, translation: '长段落' }]
          }) };
        }
        return { response: JSON.stringify({
          titleTranslation: '',
          paragraphs: [{ index: 1, translation: '短段落。' }]
        }) };
      }
    }
  };

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'PUT', {}
  ), env);

  assert.equal(response.status, 200);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes(longParagraph));
  assert.equal(prompts[1].includes(longParagraph), false);
});

test('article translation keeps the previous complete translation when a later batch fails', async t => {
  const DB = seededArticleDb(`${'x'.repeat(6101)}\n\nSecond paragraph.`);
  t.after(() => DB.close());
  DB.prepare(`
    INSERT INTO article_translations
      (article_id, user_id, title_zh, paragraphs_json, source_hash, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    'a1', 'u1', '旧标题', JSON.stringify([{ index: 0, translation: '旧译文' }]),
    'old-hash', 'old-model', 1, 1
  ).run();
  let calls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('quota'), { status: 429 });
        return { response: JSON.stringify({
          titleTranslation: '新标题', paragraphs: [{ index: 0, translation: '新译文' }]
        }) };
      }
    }
  };

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'PUT', {}
  ), env);

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'TRANSLATION_DAILY_LIMIT');
  assert.equal(DB.get(
    'SELECT title_zh FROM article_translations WHERE article_id = ?', 'a1'
  ).title_zh, '旧标题');
});

test('article translation refuses to save when the source changes during inference', async t => {
  const DB = seededArticleDb('Original body.');
  t.after(() => DB.close());
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        DB.prepare('UPDATE articles SET body = ?, updated_at = ? WHERE id = ?')
          .bind('Edited body.', 2, 'a1').run();
        return { response: JSON.stringify({
          titleTranslation: '标题', paragraphs: [{ index: 0, translation: '旧正文。' }]
        }) };
      }
    }
  };

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'PUT', {}
  ), env);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'TRANSLATION_SOURCE_CHANGED');
  assert.equal(DB.get(
    'SELECT article_id FROM article_translations WHERE article_id = ?', 'a1'
  ), null);
});

test('article translation GET never serves a stored translation with a stale source hash', async t => {
  const DB = seededArticleDb('Current body.');
  t.after(() => DB.close());
  DB.prepare(`
    INSERT INTO article_translations
      (article_id, user_id, title_zh, paragraphs_json, source_hash, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    'a1', 'u1', '旧标题', JSON.stringify([{ index: 0, translation: '旧正文。' }]),
    'stale-hash', 'model', 1, 1
  ).run();

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), { AUTH_SECRET: SECRET, DB });

  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.status, 'missing');
  assert.ok(state.sourceHash);
  assert.deepEqual(state.paragraphs, []);
});

test('article translation GET ignores an out-of-range progressive paragraph row', async t => {
  const DB = seededArticleDb('Current body.');
  t.after(() => DB.close());
  const missing = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), { AUTH_SECRET: SECRET, DB });
  const state = await missing.json();

  await DB.prepare(`INSERT INTO article_translations
    (article_id, user_id, title_zh, paragraphs_json, source_hash, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      'a1', 'u1', 'Legacy title', JSON.stringify([{ index: 0, translation: 'Legacy body.' }]),
      state.sourceHash, 'legacy-model', 1, 1
    ).run();
  await DB.prepare(`INSERT INTO article_translation_progress
    (article_id, user_id, source_hash, rules_version, title_zh, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('a1', 'u1', state.sourceHash, state.rulesVersion, 'Progress title', 'model', 1, 1).run();
  await DB.prepare(`INSERT INTO article_translation_paragraphs
    (article_id, user_id, source_hash, rules_version, paragraph_index,
     translation_zh, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('a1', 'u1', state.sourceHash, state.rulesVersion, 99, 'Orphan row.', 'model', 1, 1).run();

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), { AUTH_SECRET: SECRET, DB });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'fresh',
    titleZh: 'Legacy title',
    paragraphs: [{ index: 0, translation: 'Legacy body.' }],
    model: 'legacy-model',
    updatedAt: 1
  });
});

test('article translation GET exposes deterministic missing and partial batch state', async t => {
  const DB = seededArticleDb(`${'First paragraph. '.repeat(30)}\n\nSecond paragraph.`);
  t.after(() => DB.close());

  const missing = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), { AUTH_SECRET: SECRET, DB });
  const state = await missing.json();
  assert.equal(state.status, 'missing');
  assert.equal(state.rulesVersion, 'article-v2-progressive');
  assert.equal(state.completedBatches, 0);
  assert.ok(state.sourceHash);
  assert.deepEqual(state.paragraphs, []);

  await DB.prepare(`INSERT INTO article_translation_progress
    (article_id, user_id, source_hash, rules_version, title_zh, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('a1', 'u1', state.sourceHash, state.rulesVersion, '\u6807\u9898', 'model', 1, 1).run();
  await DB.prepare(`INSERT INTO article_translation_paragraphs
    (article_id, user_id, source_hash, rules_version, paragraph_index,
     translation_zh, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('a1', 'u1', state.sourceHash, state.rulesVersion, 0, '\u7b2c\u4e00\u6bb5\u3002', 'model', 1, 1).run();

  const partial = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), { AUTH_SECRET: SECRET, DB })).json();
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.paragraphs, [{ index: 0, translation: '\u7b2c\u4e00\u6bb5\u3002' }]);
  assert.deepEqual(partial.batches.map(batch => batch.completed), [true, false]);
});

test('article translation batch saves one deterministic batch and requests the title for batch zero', async t => {
  const DB = seededArticleDb('Only paragraph.');
  t.after(() => DB.close());
  const prompts = [];
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run(_model, input) {
        prompts.push(input.messages.at(-1).content);
        return { response: JSON.stringify({
          titleTranslation: '\u6d4b\u8bd5\u6587\u7ae0',
          paragraphs: [{ index: 0, translation: '\u552f\u4e00\u6bb5\u3002' }]
        }) };
      }
    }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );

  const translated = await requestBatch(0, {
    sourceHash: state.sourceHash,
    rulesVersion: state.rulesVersion
  });

  assert.equal(translated.status, 200);
  const result = await translated.json();
  assert.equal(result.completedBatch, 0);
  assert.equal(result.status, 'fresh');
  assert.deepEqual(result.paragraphs, [{ index: 0, translation: '\u552f\u4e00\u6bb5\u3002' }]);
  assert.equal(DB.all('SELECT * FROM article_translation_paragraphs').length, 1);
  assert.match(prompts[0], /"title":"Test article","translateTitle":true/);
});

test('article translation batch reuses a completed batch without another AI call', async t => {
  const DB = seededArticleDb('Only paragraph.');
  t.after(() => DB.close());
  let aiCalls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        aiCalls += 1;
        return { response: JSON.stringify({
          titleTranslation: '\u6807\u9898',
          paragraphs: [{ index: 0, translation: `\u8bd1\u6587 ${aiCalls}` }]
        }) };
      }
    }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );
  const body = { sourceHash: state.sourceHash, rulesVersion: state.rulesVersion };

  await requestBatch(0, body);
  const duplicate = await requestBatch(0, body);

  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).completedBatch, 0);
  assert.equal(aiCalls, 1);
});

test('article translation batch refresh calls AI again and replaces that batch', async t => {
  const DB = seededArticleDb('Only paragraph.');
  t.after(() => DB.close());
  let aiCalls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        aiCalls += 1;
        return { response: JSON.stringify({
          titleTranslation: `\u6807\u9898 ${aiCalls}`,
          paragraphs: [{ index: 0, translation: `\u8bd1\u6587 ${aiCalls}` }]
        }) };
      }
    }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );
  const body = { sourceHash: state.sourceHash, rulesVersion: state.rulesVersion };

  await requestBatch(0, body);
  const refreshed = await requestBatch(0, { ...body, refresh: true });

  assert.equal(refreshed.status, 200);
  assert.equal(aiCalls, 2);
  assert.equal(DB.get(
    'SELECT translation_zh FROM article_translation_paragraphs WHERE paragraph_index = 0'
  ).translation_zh, '\u8bd1\u6587 2');
});

test('article translation batch returns stable batch and rules validation failures', async t => {
  const DB = seededArticleDb('Only paragraph.');
  t.after(() => DB.close());
  let aiCalls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: { async run() { aiCalls += 1; return { response: '{}' }; } }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );

  const invalidBatch = await requestBatch(1, {
    sourceHash: state.sourceHash, rulesVersion: state.rulesVersion
  });
  const rulesConflict = await requestBatch(0, {
    sourceHash: state.sourceHash, rulesVersion: 'article-v1-old'
  });
  const sourceConflict = await requestBatch(0, {
    sourceHash: '0'.repeat(64), rulesVersion: state.rulesVersion
  });

  assert.equal(invalidBatch.status, 400);
  assert.equal((await invalidBatch.json()).code, 'INVALID_TRANSLATION_BATCH');
  assert.equal(rulesConflict.status, 409);
  assert.equal((await rulesConflict.json()).code, 'TRANSLATION_RULES_CHANGED');
  assert.equal(sourceConflict.status, 409);
  assert.equal((await sourceConflict.json()).code, 'TRANSLATION_SOURCE_CHANGED');
  assert.equal(aiCalls, 0);
});

test('article translation batch strictly rejects malformed request fields', async t => {
  const DB = seededArticleDb('Only paragraph.');
  t.after(() => DB.close());
  let aiCalls = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: { async run() { aiCalls += 1; return { response: '{}' }; } }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );

  for (const body of [
    { sourceHash: state.sourceHash, rulesVersion: '' },
    { sourceHash: state.sourceHash.toUpperCase(), rulesVersion: state.rulesVersion },
    { sourceHash: state.sourceHash, rulesVersion: state.rulesVersion, refresh: 'yes' },
    {
      sourceHash: state.sourceHash,
      rulesVersion: state.rulesVersion,
      paragraphs: [{ index: 0, text: 'Client-controlled text.' }]
    }
  ]) {
    const response = await requestBatch(0, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_TRANSLATION_INPUT');
  }
  assert.equal(aiCalls, 0);
});

test('article translation batch leaves storage empty when the source changes during AI', async t => {
  const DB = seededArticleDb('Original body.');
  t.after(() => DB.close());
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        DB.prepare('UPDATE articles SET body = ?, updated_at = ? WHERE id = ?')
          .bind('Edited body.', 2, 'a1').run();
        return { response: JSON.stringify({
          titleTranslation: '\u6807\u9898',
          paragraphs: [{ index: 0, translation: '\u65e7\u6b63\u6587\u3002' }]
        }) };
      }
    }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );

  const sourceChanged = await requestBatch(0, {
    sourceHash: state.sourceHash, rulesVersion: state.rulesVersion
  });

  assert.equal(sourceChanged.status, 409);
  assert.equal((await sourceChanged.json()).code, 'TRANSLATION_SOURCE_CHANGED');
  assert.equal(DB.all('SELECT * FROM article_translation_paragraphs').length, 0);
});

test('article translation batches complete in reverse order without overwriting rows', async t => {
  const DB = seededArticleDb(`${'a'.repeat(501)}\n\nSecond paragraph.`);
  t.after(() => DB.close());
  const prompts = [];
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run(_model, input) {
        const prompt = input.messages.at(-1).content;
        prompts.push(prompt);
        const index = prompt.includes('"index":1') ? 1 : 0;
        return { response: JSON.stringify({
          titleTranslation: index === 0 ? '\u6807\u9898' : '',
          paragraphs: [{ index, translation: `\u8bd1\u6587 ${index}` }]
        }) };
      }
    }
  };
  const state = await (await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/translation', 'GET'
  ), env)).json();
  const requestBatch = async (index, body) => worker.fetch(
    await authenticatedRequest(
      `/api/articles/a1/translation/batches/${index}`, 'PUT', body
    ),
    env
  );
  const body = { sourceHash: state.sourceHash, rulesVersion: state.rulesVersion };

  await requestBatch(1, body);
  const completed = await requestBatch(0, body);

  assert.equal(completed.status, 200);
  assert.deepEqual(
    DB.all('SELECT paragraph_index FROM article_translation_paragraphs ORDER BY paragraph_index')
      .map(row => row.paragraph_index),
    [0, 1]
  );
  assert.match(prompts[0], /"title":"Test article","translateTitle":false/);
  assert.match(prompts[1], /"title":"Test article","translateTitle":true/);
});

test('sentence translation context, cache reuse, and user isolation', async t => {
  const DB = seededSentenceArticlesDb();
  t.after(() => DB.close());
  const originalSegmenter = Intl.Segmenter;
  Intl.Segmenter = fineSentenceSegmenter(originalSegmenter);
  t.after(() => { Intl.Segmenter = originalSegmenter; });

  let aiCalls = 0;
  let modelPrompt = '';
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run(_model, input) {
        aiCalls += 1;
        modelPrompt = input.messages.at(-1).content;
        return { response: JSON.stringify({ translation: `译文 ${aiCalls}` }) };
      }
    }
  };
  const fineHash = await sentenceHash('Fine.');

  const first = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 1, sourceHash: fineHash }
  ), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).cached, false);
  assert.match(modelPrompt, /目标句： "Fine\."/);
  assert.match(modelPrompt, /所在段落（仅用于消歧）： "After a long argument, she said, Fine\."/);

  const second = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 1, sourceHash: fineHash }
  ), env);
  const secondResponse = await second.json();
  assert.equal(secondResponse.cached, true);
  assert.equal(aiCalls, 1);

  const reused = await worker.fetch(await authenticatedRequest(
    '/api/articles/a2/sentence-translations', 'POST',
    { sentenceIndex: 1, sourceHash: fineHash }
  ), env);
  assert.equal((await reused.json()).cached, true);
  assert.equal(aiCalls, 1);

  const differentContext = await worker.fetch(await authenticatedRequest(
    '/api/articles/a3/sentence-translations', 'POST',
    { sentenceIndex: 1, sourceHash: fineHash }
  ), env);
  assert.equal((await differentContext.json()).cached, false);
  assert.equal(aiCalls, 2);

  const otherUser = await worker.fetch(await authenticatedRequest(
    '/api/articles/a4/sentence-translations', 'GET', undefined, 'u2'
  ), env);
  const otherUserResponse = await otherUser.json();
  assert.equal(otherUserResponse.sentences.length, 0);
});

test('sentence translation refresh replaces cache only after valid AI output', async t => {
  const DB = seededArticleDb('Fine.');
  t.after(() => DB.close());
  let aiCallsAfterRefresh = 0;
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        aiCallsAfterRefresh += 1;
        return { response: JSON.stringify({
          translation: aiCallsAfterRefresh === 1 ? '旧译文' : '新译文'
        }) };
      }
    }
  };
  const requestBody = { sentenceIndex: 0, sourceHash: await sentenceHash('Fine.') };

  await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST', requestBody
  ), env);
  const refresh = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST', { ...requestBody, refresh: true }
  ), env);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.cached, false);
  assert.equal(aiCallsAfterRefresh, 2);
  assert.equal(DB.get(
    'SELECT translation_zh FROM sentence_translation_cache WHERE user_id = ?', 'u1'
  ).translation_zh, '新译文');

  env.AI.run = async () => ({ response: '{"translation":' });
  const failedRefresh = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST', { ...requestBody, refresh: true }
  ), env);
  assert.equal(failedRefresh.status, 502);
  assert.equal((await failedRefresh.json()).code, 'TRANSLATION_FORMAT_INVALID');
  assert.equal(DB.get(
    'SELECT translation_zh FROM sentence_translation_cache WHERE user_id = ?', 'u1'
  ).translation_zh, '新译文');
});

test('sentence translation validates stale invalid and oversized sentences while truncating long context', async t => {
  const DB = seededArticleDb('Fine.');
  t.after(() => DB.close());
  let calls = 0;
  let lastPrompt = '';
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run(_model, input) {
        calls += 1;
        lastPrompt = input.messages.at(-1).content;
        return { response: '{"translation":"意外调用"}' };
      }
    }
  };

  const staleResponse = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 0, sourceHash: '0'.repeat(64) }
  ), env);
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, 'TRANSLATION_SOURCE_CHANGED');

  for (const body of [
    { sentenceIndex: -1, sourceHash: '0'.repeat(64) },
    { sentenceIndex: 99, sourceHash: '0'.repeat(64) },
    { sentenceIndex: 0, sourceHash: 'not-a-hash' },
    { sentenceIndex: 0, sourceHash: '0'.repeat(64), refresh: 'yes' }
  ]) {
    const response = await worker.fetch(await authenticatedRequest(
      '/api/articles/a1/sentence-translations', 'POST', body
    ), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_TRANSLATION_INPUT');
  }

  DB.prepare('UPDATE articles SET body = ? WHERE id = ?')
    .bind('x'.repeat(6001), 'a1').run();
  const oversizedResponse = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 0, sourceHash: await sentenceHash('x'.repeat(6001)) }
  ), env);
  assert.equal(oversizedResponse.status, 413);
  assert.equal((await oversizedResponse.json()).code, 'TRANSLATION_TOO_LONG');

  DB.prepare('UPDATE articles SET body = ? WHERE id = ?')
    .bind('Short. '.repeat(5001), 'a1').run();
  const longContext = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 0, sourceHash: await sentenceHash('Short.') }
  ), env);
  assert.equal(longContext.status, 200);
  assert.equal((await longContext.json()).translation, '意外调用');
  assert.match(lastPrompt, /所在段落（仅用于消歧）：/);
  assert.ok(lastPrompt.length < 2000);

  DB.prepare('UPDATE articles SET body = ? WHERE id = ?')
    .bind('x'.repeat(30001), 'a1').run();
  const longGet = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'GET'
  ), env);
  assert.equal(longGet.status, 200);
  assert.deepEqual(await longGet.json(), {
    sentences: [],
    nextCursor: null,
    total: 1
  });

  const missing = await worker.fetch(await authenticatedRequest(
    '/api/articles/missing/sentence-translations', 'POST',
    { sentenceIndex: 0, sourceHash: await sentenceHash('Fine.') }
  ), env);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'ARTICLE_NOT_FOUND');
  assert.equal(calls, 1);
});

test('sentence translation source change during AI leaves the cache empty', async t => {
  const DB = seededArticleDb('Original body.');
  t.after(() => DB.close());
  const env = {
    AUTH_SECRET: SECRET,
    DB,
    AI: {
      async run() {
        DB.prepare('UPDATE articles SET body = ?, updated_at = ? WHERE id = ?')
          .bind('Edited body.', 2, 'a1').run();
        return { response: '{"translation":"旧正文。"}' };
      }
    }
  };

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 0, sourceHash: await sentenceHash('Original body.') }
  ), env);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'TRANSLATION_SOURCE_CHANGED');
  assert.equal(DB.get('SELECT cache_key FROM sentence_translation_cache'), null);
});

test('sentence translation cache failures are retryable and do not expose D1 details', async t => {
  const actualDb = seededArticleDb('Fine.');
  t.after(() => actualDb.close());
  let calls = 0;
  const DB = {
    prepare(sql) {
      if (/FROM sentence_translation_cache/.test(sql)) throw new Error('cache unavailable');
      return actualDb.prepare(sql);
    }
  };
  const postResponse = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'POST',
    { sentenceIndex: 0, sourceHash: await sentenceHash('Fine.') }
  ), {
    AUTH_SECRET: SECRET,
    DB,
    AI: { async run() { calls += 1; return { response: '{"translation":"意外调用"}' }; } }
  });

  assert.equal(postResponse.status, 503);
  assert.deepEqual(await postResponse.json(), {
    error: 'sentence translation cache is temporarily unavailable',
    code: 'TRANSLATION_CACHE_UNAVAILABLE',
    retryable: true
  });
  assert.equal(calls, 0);

  const getResponse = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'GET'
  ), { AUTH_SECRET: SECRET, DB });
  assert.equal(getResponse.status, 503);
  const getBody = await getResponse.json();
  assert.equal(getBody.code, 'TRANSLATION_CACHE_UNAVAILABLE');
  assert.equal(getBody.retryable, true);
  assert.doesNotMatch(JSON.stringify(getBody), /cache unavailable/);
});

test('unexpected API failures use a stable sanitized internal error', async () => {
  const response = await worker.fetch(await authenticatedRequest(
    '/api/words', 'GET'
  ), {
    AUTH_SECRET: SECRET,
    DB: { prepare() { throw new Error('private table name and SQL details'); } }
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: 'service is temporarily unavailable',
    code: 'INTERNAL_ERROR',
    retryable: true
  });
});

test('sentence translation cache GET supports long articles with bounded D1 batches', async t => {
  const actualDb = seededArticleDb(
    Array.from({ length: 501 }, (_, index) => `S${index}.`).join('\n\n')
  );
  t.after(() => actualDb.close());
  let cacheReads = 0;
  const DB = {
    prepare(sql) {
      if (/FROM sentence_translation_cache/.test(sql)) cacheReads += 1;
      return actualDb.prepare(sql);
    }
  };

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'GET'
  ), { AUTH_SECRET: SECRET, DB });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sentences: [],
    nextCursor: null,
    total: 501
  });
  assert.equal(cacheReads, 11);
});

test('sentence translation cache GET reads D1 in batches of at most fifty keys', async t => {
  const actualDb = seededArticleDb(
    Array.from({ length: 51 }, (_, index) => `Sentence ${index}.`).join(' ')
  );
  t.after(() => actualDb.close());
  const bindCounts = [];
  const DB = {
    prepare(sql) {
      const statement = actualDb.prepare(sql);
      if (!/FROM sentence_translation_cache/.test(sql)) return statement;
      return {
        bind(...values) {
          bindCounts.push(values.length);
          statement.bind(...values);
          return this;
        },
        all() { return statement.all(); }
      };
    }
  };

  const response = await worker.fetch(await authenticatedRequest(
    '/api/articles/a1/sentence-translations', 'GET'
  ), { AUTH_SECRET: SECRET, DB });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sentences: [],
    nextCursor: null,
    total: 51
  });
  assert.deepEqual(bindCounts, [51, 2]);
});

async function authenticatedRequest(path, method, body, userId = 'u1') {
  const token = await createSessionToken(userId, SECRET);
  return new Request(`https://app${path}`, {
    method,
    headers: {
      cookie: `session=${token}`,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function seededArticleDb(body) {
  const DB = createSqliteDb();
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES ('u1', 'one', 1);
  `);
  DB.prepare(`
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', '', '', 1, 1)
  `).bind('a1', 'u1', 'Test article', body).run();
  DB.prepare(`
    INSERT INTO article_progress
      (article_id, user_id, last_position_ratio, completed, read_count,
       active_read_ms, full_read_aloud_count, updated_at)
    VALUES ('a1', 'u1', 0, 0, 0, 0, 0, 1)
  `).run();
  return DB;
}

function seededSentenceArticlesDb() {
  const DB = createSqliteDb();
  DB.exec(`
    INSERT INTO users (id, username, created_at) VALUES
      ('u1', 'one', 1), ('u2', 'two', 1);
    INSERT INTO articles
      (id, user_id, title, body, author, source, notes, created_at, updated_at)
    VALUES
      ('a1', 'u1', 'One', 'After a long argument, she said, Fine.', '', '', '', 1, 1),
      ('a2', 'u1', 'Two', 'After a long argument, she said, Fine.', '', '', '', 1, 1),
      ('a3', 'u1', 'Three', 'After breakfast, he said, Fine.', '', '', '', 1, 1),
      ('a4', 'u2', 'Four', 'After a long argument, she said, Fine.', '', '', '', 1, 1);
  `);
  return DB;
}

function fineSentenceSegmenter(OriginalSegmenter) {
  return class extends OriginalSegmenter {
    segment(value) {
      const text = String(value);
      const start = text.lastIndexOf('Fine.');
      if (start < 1) return super.segment(value);
      return [
        { index: 0, segment: text.slice(0, start) },
        { index: start, segment: text.slice(start) }
      ];
    }
  };
}

async function sentenceHash(value) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
