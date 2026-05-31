/**
 * 安全 JSON 序列化：在 stringify 之前递归 sanitize 所有 string 值，把不成对的
 * UTF-16 surrogate 替换为 U+FFFD（REPLACEMENT CHARACTER）。
 */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(deepSanitizeStrings(value));
}

function deepSanitizeStrings(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSurrogates(value);
  if (Array.isArray(value)) return value.map(deepSanitizeStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepSanitizeStrings(v);
    }
    return out;
  }
  return value;
}

function sanitizeSurrogates(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '�')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, (_m, prefix) => `${prefix}�`);
}
