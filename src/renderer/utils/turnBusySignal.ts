import type { TraceTurn } from '@shared/contract/trace';

/** 一轮只允许一个进行中信号，由 TurnCard 决定它落在哪个现有组件里。 */
export function resolveBusySignal(
  turn: TraceTurn,
): 'thinking' | 'text-caret' | 'tool' | 'none' {
  if (turn.status !== 'streaming') return 'none';

  // 工具执行优先于尾部合成的空 assistant 节点：步骤行已经承担进行中态，
  // 此时不能再让通用流式光标补一个「还在忙」信号。
  const hasRunningTool = turn.nodes.some((node) => (
    node.type === 'tool_call'
    && Boolean(node.toolCall)
    && node.toolCall?.result === undefined
  ));
  if (hasRunningTool) return 'tool';

  for (let index = turn.nodes.length - 1; index >= 0; index -= 1) {
    const node = turn.nodes[index];
    if (node.type === 'assistant_text') {
      if (node.content?.trim()) return 'text-caret';
      if ((node.thinking || node.reasoning)?.trim()) return 'thinking';
      continue;
    }
    // 已完成工具会结束它之前的 reasoning 段；下一阶段是在等模型继续出字。
    if (node.type === 'tool_call') return 'text-caret';
  }

  // 首 token 前、工具收尾后等待模型继续输出，都沿用已有通用文本光标。
  return 'text-caret';
}
