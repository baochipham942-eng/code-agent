// ============================================================================
// shell 输出截断展示（纯函数，无 Ink 依赖，可单测）
// 规格：docs/design/2026-08-29-ink-tui-grok-interaction-spec.md「工具调用」节——
// shell 输出截断显示前 2 行 + 后 3 行，中间折叠为一行省略标记。
// ============================================================================

const SHELL_OUTPUT_HEAD_LINES = 2;
const SHELL_OUTPUT_TAIL_LINES = 3;

/**
 * 成功输出 → 展示行序列。≤ head+tail 行全量返回；否则
 * 前 head 行 + `… (N more lines)` + 后 tail 行。
 * 空输出 / 全空白输出返回 undefined（调用方不渲染输出区）。
 */
export function shellOutputPreview(
  output: string,
  head: number = SHELL_OUTPUT_HEAD_LINES,
  tail: number = SHELL_OUTPUT_TAIL_LINES,
): string[] | undefined {
  const lines = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // 尾部空行没有信息量（命令输出普遍以 \n 收尾），先剥掉再判断
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return undefined;
  if (lines.length <= head + tail) return lines;
  const elided = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `… (${elided} more line${elided === 1 ? '' : 's'})`,
    ...lines.slice(lines.length - tail),
  ];
}
