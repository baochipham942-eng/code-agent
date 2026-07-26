// ============================================================================
// Tool Status Labels - Per-tool dynamic status text
// Inspired by QoderWork's granular tool status system
// 词表整表在 i18n（t.toolStatus.tools），本文件只做查表与 enrich。
// ============================================================================

import type { ToolStatus } from './styles';
import type { ToolCall } from '@shared/contract';
import type { Translations } from '../../../../../i18n';

type StatusLabels = Translations['toolStatus']['default'];

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
): string | null {
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
      return enrichCompletedLabel(toolCall, t);
    case 'error':
      if (isArtifactValidationFailureAfterMutation(toolCall)) {
        return artifactValidationFailedLabel(toolCall.name, t);
      }
      return labels.error;
    case 'interrupted':
      return t.toolStatus.interrupted;
  }
}

// host 侧「写后验收」门（toolArtifactRepairPolicy.isFileMutationTool）覆盖的全部文件
// 变更工具：验收失败会被原地翻转成 result.success=false 并写
// metadata.artifactValidation.failed=true。renderer 不跨层 import host，名单手工对齐——
// host 门加工具时这里要同步加。
const ARTIFACT_VALIDATED_MUTATION_TOOLS = new Set([
  'Write',
  'write_file',
  'Edit',
  'edit_file',
  'Append',
  'append_file',
]);

function isArtifactValidationFailureAfterMutation(toolCall: ToolCall): boolean {
  if (!ARTIFACT_VALIDATED_MUTATION_TOOLS.has(toolCall.name)) return false;
  const metadata = toolCall.result?.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const artifactValidation = (metadata as { artifactValidation?: unknown }).artifactValidation;
  if (!artifactValidation || typeof artifactValidation !== 'object') return false;
  return (artifactValidation as { failed?: unknown }).failed === true;
}

function artifactValidationFailedLabel(toolName: string, t: Translations): string {
  if (toolName === 'Edit' || toolName === 'edit_file') return t.toolStatus.editValidationFailed;
  if (toolName === 'Append' || toolName === 'append_file') return t.toolStatus.appendValidationFailed;
  return t.toolStatus.writeValidationFailed;
}

/**
 * 从结果里抽出可报的数据做状态词（Grep → 找到 N 处匹配，Glob → 找到 N 个文件…）。
 * 抽不出东西时返回 null —— 光秃秃的「已完成/已创建」不值得占一个视觉位置。
 */
function enrichCompletedLabel(toolCall: ToolCall, t: Translations): string | null {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return null;

  const name = toolCall.name;

  if (name === 'Grep') {
    const match = output.match(/(\d+)\s*match/i);
    if (match) return t.toolStatus.grepMatches.replace('{count}', match[1]);
    if (output.includes('No matches') || output.includes('0 matches')) return t.toolStatus.grepNoMatches;
  }

  if (name === 'Glob') {
    const match = output.match(/(\d+)\s*file/i);
    if (match) return t.toolStatus.globFiles.replace('{count}', match[1]);
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
