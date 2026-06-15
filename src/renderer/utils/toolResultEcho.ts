// ============================================================================
// toolResultEcho - 判定 assistant 正文是否"把工具结果 JSON 原样复述"
// 小模型（如 MiMo）收到 success:false 的工具结果后，有时会把整段
// `[{"toolCallId":...,"success":false,...}]` 当成文本回显到回答里。
// 这是模型行为不是渲染 bug，渲染层据此把这种"伪正文"整段吞掉。
// ============================================================================

/**
 * content 是否为一段工具结果 JSON 数组的回显（应当隐藏，而非当答案渲染）。
 * 判定从严：要么以工具结果数组前缀开头（覆盖流式未闭合的情况），要么整段能解析成
 * 「非空数组且每个元素都带 toolCallId」。真实回答几乎不可能命中这两条。
 */
export function isToolResultEcho(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.includes('toolCallId')) return false;

  // 流式/完整都覆盖：以 [{ "toolCallId" 开头即判定（真实回答不会这样开头）
  if (/^\[\s*\{\s*"toolCallId"/.test(trimmed)) return true;

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((item) => item && typeof item === 'object' && 'toolCallId' in item)
      );
    } catch {
      // 解析失败则不当回显处理，保留原文
    }
  }
  return false;
}
