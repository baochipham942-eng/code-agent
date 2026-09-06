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
 * 「有没有匹配」只认工具返回的**结构化计数**，绝不解析正文。
 *
 * 正文解析这条路穷举不完：ai-review #1693 连着三轮各造出一个反例——
 * `docs/No matches.md`（includes 子串）、`No files matched the pattern`（整行全等漏真阳）、
 * 根目录的 `No files matched.md`（首词前缀）。只要判据落在人类可读文本上，
 * 文件名就能构造出来。Glob（glob.ts:184）与 Grep（grep.ts:421）都在 meta 里给了
 * `totalMatches`，那才是真源。
 *
 * 拿不到计数时**什么都不说**（返回 undefined），不猜——宁可少一句状态，
 * 不可把找到的结果说成没找到。
 */
function emptyMatchCount(toolCall: ToolCall): boolean | undefined {
  const total = (toolCall.result?.metadata as { totalMatches?: unknown } | undefined)?.totalMatches;
  return typeof total === 'number' ? total === 0 : undefined;
}

function enrichCompletedLabel(toolCall: ToolCall, t: Translations): string | null {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return null;

  const name = toolCall.name;

  if (name === 'Grep') {
    const match = output.match(/(\d+)\s*match/i);
    if (match) return t.toolStatus.grepMatches.replace('{count}', match[1]);
    if (emptyMatchCount(toolCall) === true) return t.toolStatus.grepNoMatches;
  }

  if (name === 'Glob') {
    const match = output.match(/(\d+)\s*file/i);
    if (match) return t.toolStatus.globFiles.replace('{count}', match[1]);
    if (emptyMatchCount(toolCall) === true) return t.toolStatus.grepNoMatches;
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
