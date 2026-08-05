import { jsonResponse } from './http.js';
import { splitArticleParagraphs } from '../public/lib/text.js';

export const TRANSLATION_MODEL = '@cf/zai-org/glm-4.7-flash';
export const TRANSLATION_RULES_VERSION = 'sentence-v2-fast';

const WORD_LIMIT = 200;
const SELECTION_LIMIT = 2000;
const ARTICLE_LIMIT = 30000;
const ARTICLE_BATCH_LIMIT = 6000;
const TRANSLATION_RULES = `你是英语到简体中文的专业翻译器。必须遵守以下规则：
1. 根据整段上下文翻译，不要逐字直译。
2. 英语中省略但中文必须表达的成分可以合理补全。
3. 保留原文的语气、强调、重复、称呼和说话风格。
4. 不增加原文没有的信息。
5. 使用自然的中文表达，避免翻译腔。
6. 只输出译文，不提供解释、注释、总结、备选版本或其他文字。`;

export async function handleTranslationApi(request, env, path, userId) {
  const articleMatch = path.match(/^\/api\/articles\/([a-zA-Z0-9-]+)\/translation$/);
  if (articleMatch) {
    if (request.method === 'GET') {
      return getArticleTranslation(env.DB, articleMatch[1], userId);
    }
    if (request.method === 'PUT') {
      return putArticleTranslation(env, articleMatch[1], userId);
    }
    return notFound();
  }
  if (request.method !== 'POST') return notFound();
  if (path === '/api/translations/word') {
    const body = await readObject(request);
    if (!body) return invalidInput();
    const text = normalizedText(body.text);
    const example = normalizedText(body.example);
    if (!text) return invalidInput();
    if (codePointLength(text) > WORD_LIMIT || codePointLength(example) > SELECTION_LIMIT) {
      return tooLong();
    }
    const prompt = example
      ? `要翻译的英语词语或短语：${JSON.stringify(text)}\n完整例句：${JSON.stringify(example)}\n请结合完整例句消歧，只输出 1 至 3 个最常用的简体中文义项，用中文分号分隔。`
      : `要翻译的英语词语或短语：${JSON.stringify(text)}\n没有例句。只输出 1 至 3 个最常用的简体中文义项，用中文分号分隔。`;
    return translatePlainText(env, prompt, userId);
  }
  if (path === '/api/translations/selection') {
    const body = await readObject(request);
    if (!body) return invalidInput();
    const text = normalizedText(body.text);
    const context = normalizedText(body.context);
    if (!text || !context) return invalidInput();
    if (codePointLength(text) > SELECTION_LIMIT || codePointLength(context) > SELECTION_LIMIT) {
      return tooLong();
    }
    const prompt = `选中的英语文本：${JSON.stringify(text)}\n完整所在句：${JSON.stringify(context)}\n根据完整句子理解语境，但只翻译选中的文本，只输出对应的简体中文译文。`;
    return translatePlainText(env, prompt, userId);
  }
  return notFound();
}

async function getArticleTranslation(DB, articleId, userId) {
  const article = await DB.prepare(`
    SELECT id, title, body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
  if (!article) return articleNotFound();
  const row = await DB.prepare(`
    SELECT title_zh, paragraphs_json, source_hash, model, updated_at
    FROM article_translations WHERE article_id = ? AND user_id = ?
  `).bind(articleId, userId).first();
  if (!row) return jsonResponse({ status: 'missing' });
  if (row.source_hash !== await articleSourceHash(article.title, article.body)) {
    return jsonResponse({ status: 'missing' });
  }
  const paragraphs = parseStoredParagraphs(row.paragraphs_json);
  if (!paragraphs) return aiFailure('TRANSLATION_FORMAT_INVALID', 502);
  return jsonResponse({
    status: 'fresh',
    titleZh: row.title_zh,
    paragraphs,
    model: row.model,
    updatedAt: Number(row.updated_at)
  });
}

async function putArticleTranslation(env, articleId, userId) {
  const article = await env.DB.prepare(`
    SELECT id, title, body FROM articles WHERE id = ? AND user_id = ?
  `).bind(articleId, userId).first();
  if (!article) return articleNotFound();
  if (Array.from(article.body).length > ARTICLE_LIMIT) return tooLong();
  if (codePointLength(article.title) > SELECTION_LIMIT) return tooLong();
  if (!env.AI?.run) return aiFailure('TRANSLATION_NOT_CONFIGURED');
  const sourceHash = await articleSourceHash(article.title, article.body);

  const paragraphs = splitArticleParagraphs(article.body).paragraphs
    .map(paragraph => ({ index: paragraph.index, text: paragraph.text }));
  if (!paragraphs.length) return invalidInput();
  const batches = articleBatches(paragraphs);
  const translated = [];
  let titleZh = '';

  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const task = {
        title: article.title,
        translateTitle: batchIndex === 0,
        paragraphs: batch
      };
      const result = await runTranslationModel(env, {
        messages: [
          { role: 'system', content: `${TRANSLATION_RULES}\n文章翻译必须返回严格 JSON，不能使用 Markdown 代码块。保持每个自然段内部的换行、语气、强调和重复。` },
          { role: 'user', content: `翻译任务 JSON：${JSON.stringify(task)}\n只返回 {"titleTranslation":"...","paragraphs":[{"index":0,"translation":"..."}]}。paragraphs 必须与本批索引一一对应。` }
        ],
        temperature: 0,
        max_completion_tokens: 4096
      });
      const parsed = parseArticleResult(responseText(result), batch);
      if (!parsed) return aiFailure('TRANSLATION_FORMAT_INVALID', 502);
      if (batchIndex === 0) titleZh = parsed.titleTranslation;
      translated.push(...parsed.paragraphs);
    }
  } catch (error) {
    return mapAiError(error);
  }

  if (!titleZh || translated.length !== paragraphs.length) {
    return aiFailure('TRANSLATION_FORMAT_INVALID', 502);
  }
  translated.sort((left, right) => left.index - right.index);
  const now = Date.now();
  const saved = await env.DB.prepare(`
    INSERT INTO article_translations
      (article_id, user_id, title_zh, paragraphs_json, source_hash,
       model, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    FROM articles
    WHERE id = ? AND user_id = ? AND title = ? AND body = ?
    ON CONFLICT(article_id) DO UPDATE SET
      user_id = excluded.user_id,
      title_zh = excluded.title_zh,
      paragraphs_json = excluded.paragraphs_json,
      source_hash = excluded.source_hash,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).bind(
    articleId, userId, titleZh, JSON.stringify(translated), sourceHash,
    TRANSLATION_MODEL, now, now,
    articleId, userId, article.title, article.body
  ).run();
  if (!saved.meta.changes) return sourceChanged();
  return jsonResponse({
    status: 'fresh', titleZh, paragraphs: translated,
    model: TRANSLATION_MODEL, updatedAt: now
  });
}

function translationError(code, status = 503) {
  return Object.assign(new Error('translation unavailable'), {
    translationCode: code,
    httpStatus: status
  });
}

export async function generatePlainTranslation(env, prompt) {
  if (!env.AI?.run) throw translationError('TRANSLATION_NOT_CONFIGURED');
  try {
    const result = await runTranslationModel(env, {
      messages: [
        {
          role: 'system',
          content: `${TRANSLATION_RULES}\n为便于服务端校验，必须严格返回 {"translation":"译文"} JSON，不能使用 Markdown 代码块，不能添加其他字段或 JSON 外文字。`
        },
        { role: 'user', content: `${prompt}\n把唯一的译文放入 translation 字段。` }
      ],
      temperature: 0,
      max_completion_tokens: 512
    });
    const translation = parsePlainResult(responseText(result));
    if (!translation) throw translationError('TRANSLATION_FORMAT_INVALID', 502);
    return translation;
  } catch (error) {
    if (error?.translationCode) throw error;
    const status = Number(error?.status || error?.cause?.status || 0);
    if (status === 429) throw translationError('TRANSLATION_DAILY_LIMIT', 429);
    if (error?.code === 'TRANSLATION_TIMEOUT') {
      throw translationError('TRANSLATION_TIMEOUT', 504);
    }
    throw translationError('TRANSLATION_UNAVAILABLE');
  }
}

export function translationFailureResponse(error) {
  return aiFailure(error?.translationCode || 'TRANSLATION_UNAVAILABLE', error?.httpStatus || 503);
}

async function translatePlainText(env, prompt) {
  try {
    return jsonResponse({ translation: await generatePlainTranslation(env, prompt) });
  } catch (error) {
    return translationFailureResponse(error);
  }
}

async function runTranslationModel(env, input) {
  const configured = Number(env.TRANSLATION_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      env.AI.run(TRANSLATION_MODEL, input, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('translation timed out'), { code: 'TRANSLATION_TIMEOUT' }));
          controller.abort();
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parsePlainResult(value) {
  if (!value || !value.startsWith('{') || !value.endsWith('}')) return '';
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'translation')
      || typeof parsed.translation !== 'string'
    ) return '';
    return parsed.translation.trim();
  } catch {
    return '';
  }
}

function responseText(result) {
  const value = result?.choices?.[0]?.message?.content ?? result?.response;
  return typeof value === 'string' ? value.trim() : '';
}

function articleBatches(paragraphs) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const paragraphLength = Array.from(paragraph.text).length;
    if (current.length && length + paragraphLength > ARTICLE_BATCH_LIMIT) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(paragraph);
    length += paragraphLength;
    if (paragraphLength > ARTICLE_BATCH_LIMIT) {
      batches.push(current);
      current = [];
      length = 0;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseArticleResult(value, expected) {
  if (!value || !value.startsWith('{') || !value.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !hasExactKeys(parsed, ['titleTranslation', 'paragraphs'])
      || typeof parsed.titleTranslation !== 'string'
      || !Array.isArray(parsed.paragraphs)
    ) return null;
    const expectedIndexes = expected.map(item => item.index);
    const paragraphs = parsed.paragraphs.map(item => ({
      index: item?.index,
      translation: typeof item?.translation === 'string' ? item.translation.trim() : ''
    }));
    if (
      paragraphs.length !== expectedIndexes.length
      || parsed.paragraphs.some(item => !hasExactKeys(item, ['index', 'translation']))
      || paragraphs.some(item => !Number.isInteger(item.index) || !item.translation)
      || new Set(paragraphs.map(item => item.index)).size !== paragraphs.length
      || paragraphs.some(item => !expectedIndexes.includes(item.index))
    ) return null;
    return {
      titleTranslation: typeof parsed.titleTranslation === 'string'
        ? parsed.titleTranslation.trim()
        : '',
      paragraphs
    };
  } catch {
    return null;
  }
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && expected.slice().sort().every((key, index) => keys[index] === key);
}

function parseStoredParagraphs(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.every(item => Number.isInteger(item?.index) && typeof item?.translation === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function articleSourceHash(title, body) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify({ title, body }))
  );
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

async function readObject(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizedText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function codePointLength(value) {
  return Array.from(value).length;
}

function mapAiError(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  if (status === 429) return aiFailure('TRANSLATION_DAILY_LIMIT', 429);
  if (error?.code === 'TRANSLATION_TIMEOUT') return aiFailure('TRANSLATION_TIMEOUT', 504);
  return aiFailure('TRANSLATION_UNAVAILABLE');
}

function invalidInput() {
  return jsonResponse(
    { error: 'invalid translation input', code: 'INVALID_TRANSLATION_INPUT' },
    { status: 400 }
  );
}

function tooLong() {
  return jsonResponse(
    { error: 'translation input is too long', code: 'TRANSLATION_TOO_LONG' },
    { status: 413 }
  );
}

function sourceChanged() {
  return jsonResponse(
    { error: 'article changed during translation', code: 'TRANSLATION_SOURCE_CHANGED' },
    { status: 409 }
  );
}

function aiFailure(code, status = 503) {
  return jsonResponse({ error: 'translation unavailable', code }, { status });
}

function articleNotFound() {
  return jsonResponse(
    { error: 'article not found', code: 'ARTICLE_NOT_FOUND' },
    { status: 404 }
  );
}

function notFound() {
  return jsonResponse({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
}
