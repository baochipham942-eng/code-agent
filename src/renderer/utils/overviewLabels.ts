// ============================================================================
// overviewLabels —— 概览四模块的人话标签兜底（工单 A.5：内部 ID 禁漏）
// ----------------------------------------------------------------------------
// `tool-result-tool-775064011…` 这类内部 ID 不得出现在任何行；解析不出名字时
// 由调用方给 i18n 兜底文案（「未命名输出/未知能力」），绝不兜底 ID 本身。
// ============================================================================

/** 原始内部 ID 形态：tool-result/tool-call 前缀，或带 ≥9 位连续数字的标识串 */
export function looksLikeInternalId(label: string): boolean {
  return /tool[-_ ]?(result|call)/i.test(label) || /\d{9,}/.test(label);
}

/** label 为人话则原样返回，否则回退到调用方给的 i18n 兜底文案 */
export function humanContextLabel(label: string | undefined, fallback: string): string {
  const trimmed = label?.trim() ?? '';
  if (!trimmed || looksLikeInternalId(trimmed)) return fallback;
  return trimmed;
}
