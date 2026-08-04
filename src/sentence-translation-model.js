import { jsonResponse } from './http.js';
import { TRANSLATION_MODEL } from './translation-api.js';

const TRANSLATION_RULES = `你是英语到简体中文的专业翻译器。必须遵守以下规则：
1. 根据提供的上下文理解目标句，但只翻译目标句。
2. 使用自然的简体中文，避免逐字直译。
3. 保留原文语气、强调和称呼。
4. 不增加原文没有的信息。
5. 优先返回 {"translation":"译文"} JSON；无法严格返回 JSON 时，只返回译文本身。`;

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

export function parseTranslationResult(result) {
  const raw = responseText(result);
  if (!raw) return '';
  const cleaned = stripCodeFence(raw);

  for (const candidate of jsonCandidates(cleaned)) {
    try {
      const parsed = JSON.parse(candidate);
      const translation = translationValue(parsed);
      if (translation) return translation;
    } catch {
      // Continue with the next candidate or the plain-text fallback.
    }
  }

  return plainTranslation(cleaned);
}

function responseText(result) {
  const value = result?.choices?.[0]?.message?.content ?? result?.response ?? result;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

function stripCodeFence(value) {
  const text = String(value || '').trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] || text).trim();
}

function jsonCandidates(value) {
  const candidates = [value];
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(value.slice(first, last + 1));
  return [...new Set(candidates)];
}

function translationValue(value) {
  if (typeof value === 'string') return sanitize(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['translation', 'translatedText', 'text', 'response']) {
    if (typeof value[key] === 'string') {
      const translation = sanitize(value[key]);
      if (translation) return translation;
    }
  }
  return '';
}

function plainTranslation(value) {
  let text = String(value || '').trim();
  if (!text || /^[{[]/.test(text)) return '';
  text = text
    .replace(/^(?:translation|translated text|译文|翻译)\s*[:：]\s*/i, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .trim();
  if (!text || text.length > 12000) return '';
  return text;
}

function sanitize(value) {
  const text = String(value || '').normalize('NFKC').trim();
  return text && text.length <= 12000 ? text : '';
}

function translationError(code, status) {
  return Object.assign(new Error(code), {
    translationCode: code,
    httpStatus: status
  });
}
