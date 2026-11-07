// ============================================================================
// usageLimitDetection — 供应商「用量窗口」429 的结构化识别
//
// 套餐类供应商（GLM Coding Plan 等）额度用尽返回 HTTP 429，正文是一句人话
// （「已达到 5 小时的使用上限。您的限额将在 2026-11-03 17:34:10 重置。」），
// 没有 1308 / "rate limit" 字样，普通限流的识别规则认不出它。
// 这里按 status 429 / 错误码 1308·1310 + 用量上限措辞识别，沿 cause / responseBody 链上溯。
// 与普通 429（Rate limit reached…）区分：只有明确的「用量上限」措辞才算。
// ============================================================================

export interface UsageLimitInfo {
  /** 服务商写的窗口词，如「5 小时」/ "5-hour"。没有就不填。 */
  windowText?: string;
  /** ISO-8601 UTC。只有正文写明了重置时间才填。 */
  resetAt?: string;
}

const MAX_CHAIN_DEPTH = 6;
const SOURCE_TEXT_LIMIT = 4000;
/** 无时区的时间戳按智谱所在的北京时间解释。 */
const ZONELESS_OFFSET = '+08:00';

const USAGE_LIMIT_WORDING = /已达到[^。\n]{0,16}上限|使用上限|限额将|额度将|usage limit|\b(?:5|five)[- ]hour (?:limit|window|quota)/i;
// 错误码只认结构化形态（code 字段 / 中文「错误码」措辞）：裸数字 1308/1310 会撞上端口、
// token 数、毫秒数（connect ECONNREFUSED 127.0.0.1:1308），把网络错误报成「额度用尽」。
const PROVIDER_QUOTA_CODE = /["']?code["']?\s*[:=]\s*["']?(?:1308|1310)\b|错误码\s*(?:1308|1310)\b/;
const WINDOW_TEXT = /(\d+\s*个?\s*小时)|(\d+\s*-?\s*hours?)|(每周|每月|周额度|月额度)|\b(weekly|monthly)\b/i;
const RESET_TIME = /(?:将在|将于|将|重置时间[:：]?|resets?(?:\s+(?:at|on))?)\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?|(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?\s*重置/i;

function statusOf(record: Record<string, unknown>): number | undefined {
  const status = record.statusCode ?? record.status;
  return typeof status === 'number' ? status : undefined;
}

function collectChain(error: unknown): { text: string; has429: boolean } {
  if (typeof error === 'string') return { text: error, has429: /\b429\b/.test(error) };
  const parts: string[] = [];
  let has429 = false;
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && cursor != null && typeof cursor === 'object' && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    const record = cursor as Record<string, unknown>;
    if (statusOf(record) === 429) has429 = true;
    if (typeof record.message === 'string' && record.message) parts.push(record.message);
    if (typeof record.responseBody === 'string' && record.responseBody.trim()) parts.push(record.responseBody.trim());
    cursor = record.cause;
  }
  const text = parts.join('\n');
  return { text: text.length > SOURCE_TEXT_LIMIT ? text.slice(0, SOURCE_TEXT_LIMIT) : text, has429 };
}

function toResetIso(dateTime: string, zone: string | undefined): string | undefined {
  const normalized = dateTime.replace(' ', 'T');
  const withSeconds = /T\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
  const offset = zone ? (zone === 'Z' || zone === 'z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : ZONELESS_OFFSET;
  const date = new Date(`${withSeconds}${offset}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * 判定一个错误是否为「用量窗口用尽」。是则返回窗口词与重置时间（解析不出的字段缺省）。
 * 普通 429（无用量上限措辞）返回 undefined。
 */
export function detectUsageLimit(error: unknown): UsageLimitInfo | undefined {
  const { text, has429 } = collectChain(error);
  if (!text) return undefined;
  const hasQuotaCode = PROVIDER_QUOTA_CODE.test(text);
  const hasWording = USAGE_LIMIT_WORDING.test(text);
  if (!hasWording && !hasQuotaCode) return undefined;
  if (!has429 && !hasQuotaCode) return undefined;

  const info: UsageLimitInfo = {};
  const windowText = text.match(WINDOW_TEXT)?.[0]?.trim();
  if (windowText) info.windowText = windowText.slice(0, 40);
  const reset = text.match(RESET_TIME);
  if (reset) {
    const resetAt = reset[1] ? toResetIso(reset[1], reset[2]) : toResetIso(reset[3], reset[4]);
    if (resetAt) info.resetAt = resetAt;
  }
  return info;
}
