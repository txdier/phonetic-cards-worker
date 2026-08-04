import { jsonResponse } from './http.js';
import { TRANSLATION_MODEL } from './translation-api.js';
import {
  parseTranslationResult,
  TRANSLATION_RESPONSE_FORMAT
} from './translation-result.js';

const TRANSLATION_RULES = `你是英语到简体中文的专业翻译器。必须遵守以下规则：
1. 根据提供的上下文理解目标句，但只翻译目标句。
2. 使用自然的简体中文，避免逐字直译。
3. 保留原文语气、强调和称呼。
4. 不增加原文没有的信息。
5. 返回 translation 字段，不提供解释、分析或其他文字。`;

export async function generateSentenceTranslation(env, prompt) {
  if (!env.AI?.run) throw translationError('TRANSLATION_NOT_CONFIGURED', 503);
  const configured = Number(env.TRANSLATION_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  const controller = new AbortController();
  let timer;

  try {
    const result = await Promise.race([
      env.AI.run(TRANSLATION_MODEL, {
        messages: [
          { role: 'system', content: TRANSLATION_RULES },
          { role: 'user', content: prompt }
        ],
        response_format: TRANSLATION_RESPONSE_FORMAT,
        temperature: 0,
        max_completion_tokens: 768
      }, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(translationError('TRANSLATION_TIMEOUT', 504));
        }, timeoutMs);
      })
    ]);
    const translation = parseTranslationResult(result);
    if (!translation) throw translationError('TRANSLATION_FORMAT_INVALID', 502);
    return translation;
  } catch (error) {
    if (error?.translationCode) throw error;
    const status = Number(error?.status || error?.cause?.status || 0);
    if (status === 429) throw translationError('TRANSLATION_DAILY_LIMIT', 429);
    throw translationError('TRANSLATION_UNAVAILABLE', 503);
  } finally {
    clearTimeout(timer);
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

function translationError(code, status) {
  return Object.assign(new Error(code), {
    translationCode: code,
    httpStatus: status
  });
}
