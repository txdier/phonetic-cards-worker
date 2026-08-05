import { jsonResponse } from './http.js';
import { parseTranslationResult } from './translation-result.js';

export { parseTranslationResult } from './translation-result.js';

export const SENTENCE_TRANSLATION_MODEL = '@cf/meta/llama-3.2-3b-instruct';

const DEFAULT_SENTENCE_TRANSLATION_TIMEOUT_MS = 15000;
const TRANSLATION_RULES = `你是英语到简体中文的专业翻译器。请根据提供的段落语境理解目标句，但只翻译目标句。译文必须自然、准确，保留原文语气，不添加原文没有的信息。只输出简体中文译文，不要解释、分析、标签或 Markdown。`;

export async function generateSentenceTranslation(env, prompt) {
  if (!env.AI?.run) throw translationError('TRANSLATION_NOT_CONFIGURED', 503);
  const input = {
    messages: [
      { role: 'system', content: TRANSLATION_RULES },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    max_tokens: 192
  };

  try {
    const result = await runWithTimeout(env, input);
    const translation = parseTranslationResult(result);
    if (!translation) throw translationError('TRANSLATION_FORMAT_INVALID', 502);
    return translation;
  } catch (error) {
    if (error?.translationCode) throw error;
    const status = Number(error?.status || error?.cause?.status || 0);
    if (status === 429) throw translationError('TRANSLATION_DAILY_LIMIT', 429);
    if (error?.code === 'TRANSLATION_TIMEOUT') {
      throw translationError('TRANSLATION_TIMEOUT', 504);
    }
    throw translationError('TRANSLATION_UNAVAILABLE', 503);
  }
}

export function sentenceTranslationFailureResponse(error) {
  const code = error?.translationCode || 'TRANSLATION_UNAVAILABLE';
  const messages = {
    TRANSLATION_NOT_CONFIGURED: '翻译服务尚未配置',
    TRANSLATION_DAILY_LIMIT: '翻译服务今日额度已用完，请稍后再试',
    TRANSLATION_TIMEOUT: '翻译请求超时，请重试',
    TRANSLATION_FORMAT_INVALID: '翻译结果格式异常，请重试',
    TRANSLATION_UNAVAILABLE: '翻译服务暂时不可用，请稍后重试'
  };
  return jsonResponse(
    { error: messages[code] || messages.TRANSLATION_UNAVAILABLE, code },
    { status: error?.httpStatus || 503 }
  );
}

async function runWithTimeout(env, input) {
  const sentenceConfigured = Number(env.SENTENCE_TRANSLATION_TIMEOUT_MS);
  const sharedConfigured = Number(env.TRANSLATION_TIMEOUT_MS);
  const configured = Number.isFinite(sentenceConfigured) && sentenceConfigured > 0
    ? sentenceConfigured
    : sharedConfigured;
  const timeoutMs = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SENTENCE_TRANSLATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      env.AI.run(SENTENCE_TRANSLATION_MODEL, input, { signal: controller.signal }),
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

function translationError(code, status) {
  return Object.assign(new Error(code), {
    translationCode: code,
    httpStatus: status
  });
}
