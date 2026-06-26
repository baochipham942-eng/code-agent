// ============================================================================
// 协作可见性（P1-3）：子代理自报人话状态 + 决策点
// ============================================================================
// 让每个并行子代理在最终输出末尾自报一行 STATUS（人话状态）、可选一行 DECISION
// （关键方案选择/分歧），由 spawnAgent 的 onTaskComplete 解析后 emit 成讨论流事件。
// 单独成模块（无重依赖）便于确定性单测覆盖解析逻辑。

export const SWARM_STATUS_REPORT_SUFFIX = `

---
【协作可见性】完成任务后，在你最终输出的末尾追加状态行，让协调者和用户看懂你做了什么：
- 必须：一行 \`STATUS: <一句话说明你完成了什么、是否改动了产品代码>\`
- 可选：若你做了关键方案选择，或与其它 agent 的结论有分歧，再追加一行 \`DECISION: <你的决策及理由>\`
每行一句陈述句，不要编造未发生的动作。`;

/**
 * 从子代理输出中解析自报的 STATUS / DECISION 行（最后一次出现为准）。
 * 容错：大小写不敏感，允许中文冒号，允许行首空白；忽略空内容。
 */
export function parseStatusReport(output: string): { status?: string; decision?: string } {
  if (!output) return {};
  let status: string | undefined;
  let decision: string | undefined;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    const statusMatch = line.match(/^STATUS[:：]\s*(.+)$/i);
    if (statusMatch) {
      const value = statusMatch[1].trim();
      if (value) status = value;
      continue;
    }
    const decisionMatch = line.match(/^DECISION[:：]\s*(.+)$/i);
    if (decisionMatch) {
      const value = decisionMatch[1].trim();
      if (value) decision = value;
    }
  }
  return { status, decision };
}
