import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSessionToken } from '../src/auth.js';
import worker from '../src/index.js';
import { createSqliteDb } from './helpers/sqlite-db.js';

const SECRET = 'translation-test-secret';

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
  assert.deepEqual(await response.json(), { status: 'missing' });
});

async function authenticatedRequest(path, method, body) {
  const token = await createSessionToken('u1', SECRET);
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
