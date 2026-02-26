// ============================================================================
// Truncate Utilities - 智能文本截断
// ============================================================================
//
// 借鉴 Codex CLI 的中间截断策略：保留首尾，截断中间。
// 模型通常需要看到输出的开头（错误信息、结构信息）和结尾（总结、状态）。

/**
 * 中间截断 — 保留首尾，截断中间
 *
 * 在行边界截断，避免截断一行的中间。
 *
 * @param text - 原始文本
 * @param maxLength - 最大字符数
 * @param headRatio - 头部占比（默认 0.5，即各占一半）
 * @returns 截断后的文本，如果未超限则返回原文
 */
export function truncateMiddle(
  text: string,
  maxLength: number,
  headRatio = 0.5
): string {
  if (text.length <= maxLength) return text;

  const reserveForMarker = 60; // "[N characters truncated]" 标记预留
  const budget = maxLength - reserveForMarker;
  const headBudget = Math.floor(budget * headRatio);
  const tailBudget = budget - headBudget;

  // 在行边界截断
  const headPart = text.substring(0, headBudget);
  const tailPart = text.substring(text.length - tailBudget);

  const headEnd = headPart.lastIndexOf('\n');
  const tailStart = tailPart.indexOf('\n');

  const cleanHead = headEnd > headBudget * 0.5
    ? headPart.substring(0, headEnd)
    : headPart;

  const cleanTail = tailStart >= 0 && tailStart < tailBudget * 0.5
    ? tailPart.substring(tailStart + 1)
    : tailPart;

  const removed = text.length - cleanHead.length - cleanTail.length;

  return `${cleanHead}\n\n... [${removed} characters truncated] ...\n\n${cleanTail}`;
}

/**
 * 头部截断（旧行为兼容）— 只保留开头
 *
 * @param text - 原始文本
 * @param maxLength - 最大字符数
 * @returns 截断后的文本
 */
export function truncateHead(
  text: string,
  maxLength: number
): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '\n... (output truncated)';
}
