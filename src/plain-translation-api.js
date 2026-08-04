import { jsonResponse } from './http.js';
import { TRANSLATION_MODEL } from './translation-api.js';
import {
  parseTranslationResult,
  TRANSLATION_RESPONSE_FORMAT
} from './translation-result.js';

const WORD_LIMIT = 200;
const SELECTION_LIMIT = 2000;
const TRANSLATION_RULES = `你是英语到简体中文的专业翻译器。必须遵守以下规则：
1. 根据完整上下文理解词义，不要逐字直译。
2. 英语中省略但中文必须表达的成分可以合理补全。
3. 保留原文语气、强调、重复、称呼和说话风格。
4. 不增加原文没有的信息。
5. 使用自然的简体中文表达，避免翻译腔。
6. 返回 translation 字段，不提供解释、分析、总结或备选答案。`;

export async function handlePlainTranslationApi(request, env, path) {
  if (request.method !== 'POST') return notFound();
  const body = await readObject(request);
  if (!body) return invalidInput();

  if (path === '/api/translations/word') {
    const text = normalizedText(body.text);
    const example = normalizedText(body.example);
    if (!text) return invalidInput();
    if (codePointLength(text) > WORD_LIMIT || codePointLength(example) > SELECTION_LIMIT) {
      return tooLong();
    }
    const prompt = example
      ? `要翻译的英语词语或短语：${JSON.stringify(text)}\n完整例句：${JSON.stringify(example)}\n请结合完整例句消歧，只返回 1 至 3 个最常用的简体中文义项，用中文分号分隔。`
      : `要翻译的英语词语或短语：${JSON.stringify(text)}\n没有例句。只返回 1 至 3 个最常用的简体中文义项，用中文分号分隔。`;
    return translate(env, prompt);
  }

  if (path === '/api/translations/selection') {
    const text = normalizedText(body.text);
    const context = normalizedText(body.context);
    if (!text || !context) return invalidInput();
    if (codePointLength(text) > SELECTION_LIMIT || codePointLength(context) > SELECTION_LIMIT) {
      return tooLong();
    }
    const prompt = `选中的英语文本：${JSON.stringify(text)}\n完整所在句：${JSON.stringify(context)}\n根据完整句子理解语境，但只翻译选中的文本。`;
    return translate(env, prompt);
  }

  return notFound();
}

async function translate(env, prompt) {
  if (!env.AI?.run) return failure('TRANSLATION_NOT_CONFIGURED', 503);
  const input = {
    messages: [
      { role: 'system', content: TRANSLATION_RULES },
      { role: 'user', content: prompt }
    ],
    response_format: TRANSLATION_RESPONSE_FORMAT,
    temperature: 0,
    max_completion_tokens: 512
  };

  try {
    const result = await runModel(env, input);
    const translation = parseTranslationResult(result);
    if (!translation) return failure('TRANSLATION_FORMAT_INVALID', 502);
    return jsonResponse({ translation });
  } catch (error) {
    const status = Number(error?.status || error?.cause?.status || 0);
    if (status === 429) return failure('TRANSLATION_DAILY_LIMIT', 429);
    if (error?.code === 'TRANSLATION_TIMEOUT') return failure('TRANSLATION_TIMEOUT', 504);
    return failure('TRANSLATION_UNAVAILABLE', 503);
  }
}

async function runModel(env, input) {
  try {
    return await runWithTimeout(env, input);
  } catch (error) {
    if (!isResponseFormatError(error)) throw error;
    const fallback = { ...input };
    delete fallback.response_format;
    return runWithTimeout(env, fallback);
  }
}

async function runWithTimeout(env, input) {
  const configured = Number(env.TRANSLATION_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      env.AI.run(TRANSLATION_MODEL, input, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('translation timed out'), {
            code: 'TRANSLATION_TIMEOUT'
          }));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isResponseFormatError(error) {
  const message = String(error?.message || error?.cause?.message || '');
  return /response[_ -]?format|json mode|json schema|structured output/i.test(message);
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

function failure(code, status) {
  return jsonResponse({ error: 'translation unavailable', code }, { status });
}

function notFound() {
  return jsonResponse({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
}
