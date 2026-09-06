// ============================================================================
// Tool Status Labels - Per-tool dynamic status text
// Inspired by QoderWork's granular tool status system
// 词表整表在 i18n（t.toolStatus.tools），本文件只做查表与 enrich。
// ============================================================================

import type { ToolStatus } from './styles';
import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../i18n';
import { humanizeToolFailureReason, resolveToolTerminalOutcomeKey } from '../../../../../utils/toolExecutionPresentation';
import { resolveStreamInterruptionOutcomeKey } from '../../../../../i18n/outcomeWords';
import type { StreamInterruptionReason } from '@shared/contract';

type StatusLabels = Pick<Translations['toolStatus']['default'], 'preparing' | 'running'>;

/**
 * Get the dynamic status label for a tool call.
 * Uses two-phase pending: _streaming → preparing, !_streaming → running.
 *
 * 成功且没有可报的结果数据时返回 null：步骤行主文案本身已经是一句过去时人话
 * （「写入了 notes.md」），再前置一个「已创建」就是同一个动词讲两遍，且成败已由
 * 左侧 StatusIndicator 的符号表达。带结果的状态词（找到 N 处 / 已读取 N 行 /
 * 退出码 N）继续显示——那不是重复动词，是新信息。
 */
export function getToolStatusLabel(
  toolCall: ToolCall,
  status: ToolStatus,
  t: Translations,
  awaitingApproval = false,
  interruptionReason?: StreamInterruptionReason,
): string | null {
  if (awaitingApproval) return t.toolStepHumanize.pendingApprovalStatus;
  const toolName = toolCall.name;

  const tools = t.toolStatus.tools as Record<string, StatusLabels | undefined>;
  let labels = tools[toolName];
  if (!labels && (toolName.startsWith('mcp_') || toolName.startsWith('mcp__'))) {
    labels = t.toolStatus.mcp;
  }
  if (!labels) labels = t.toolStatus.default;

  switch (status) {
    case 'pending':
      return toolCall._streaming ? labels.preparing : labels.running;
    case 'success':
      if (toolCall.name === 'spawn_agent') {
        const background = toolCall.result?.output?.includes('spawned in background')
          || toolCall.result?.output?.includes('Status: running');
        return background
          ? t.chat.delegationReceipt.dispatched
          : t.chat.delegationReceipt.completed;
      }
      return enrichCompletedLabel(toolCall, t);
    case 'error': {
      const outcome = t.outcomeWords[resolveToolTerminalOutcomeKey(toolCall)].timeline;
      return `${outcome.label} · ${humanizeToolFailureReason(toolCall, t)}`;
    }
    case 'interrupted':
      return t.outcomeWords[resolveStreamInterruptionOutcomeKey(interruptionReason)].timeline.label;
  }
}

/**
 * 从结果里抽出可报的数据做状态词（Grep → 找到 N 处匹配，Glob → 找到 N 个文件…）。
 * 抽不出东西时返回 null —— 光秃秃的「已完成/已创建」不值得占一个视觉位置。
 */
/**
 * 「无匹配」判据锚在工具**自己产生的那两条字面量**上，且必须出现在输出首行的开头：
 *   - Glob 空结果 = `No files matched the pattern`（glob.ts:180）
 *   - Grep 空结果 = `No matches found`（grep.ts:420 等多处）
 *
 * 为什么不用 includes：Glob 找到一个名叫 `No matches.md` 的文件时，子串判定会把有结果
 * 说成无结果（ai-review #1693 第一轮）。
 * 为什么不用整行全等：真实输出后面还带着别的词，全等会把真的空结果漏掉
 * ——第一版就是这么改紧过头的（同一轮第二次判红）。真阳真阴各一条测试一起钉。
 */
function isEmptyResultMarker(output: string): boolean {
  const first = output.split('\n', 1)[0]?.trim() ?? '';
  return /^(no matches found|no files matched|0 matches)\b/i.test(first);
}

function enrichCompletedLabel(toolCall: ToolCall, t: Translations): string | null {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return null;

  const name = toolCall.name;

  if (name === 'Grep') {
    const match = output.match(/(\d+)\s*match/i);
    if (match) return t.toolStatus.grepMatches.replace('{count}', match[1]);
    if (isEmptyResultMarker(output)) return t.toolStatus.grepNoMatches;
  }

  if (name === 'Glob') {
    const match = output.match(/(\d+)\s*file/i);
    if (match) return t.toolStatus.globFiles.replace('{count}', match[1]);
    if (isEmptyResultMarker(output)) return t.toolStatus.grepNoMatches;
  }

  if (name === 'Read') {
    const match = output.match(/(\d+)\s*lines?\b/i);
    if (match) return t.toolStatus.readLines.replace('{count}', match[1]);
  }

  if (name === 'Bash' || name === 'bash') {
    // P0 #4：success 态下退出码非 0，仍把退出码 surface 出来（信息保留），但**不再**附「结果判定
    // 可能不可靠」——success 与「不可靠」自相矛盾（真正失败会走 error 态）。中性展示，去噪不误导。
    const exitCode = (toolCall.result?.metadata as { exitCode?: unknown } | undefined)?.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      return t.toolStatus.bashExitCode.replace('{code}', String(exitCode));
    }
  }

  return null;
}
