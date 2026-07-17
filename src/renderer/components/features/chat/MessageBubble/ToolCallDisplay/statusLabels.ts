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
 */
export function getToolStatusLabel(
  toolCall: ToolCall,
  status: ToolStatus,
  t: Translations,
): string {
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
      return enrichCompletedLabel(toolCall, labels.completed, t);
    case 'error':
      if (isArtifactValidationFailureAfterWrite(toolCall)) {
        return t.toolStatus.writeValidationFailed;
      }
      return labels.error;
    case 'interrupted':
      return t.toolStatus.interrupted;
  }
}

function isArtifactValidationFailureAfterWrite(toolCall: ToolCall): boolean {
  if (toolCall.name !== 'Write' && toolCall.name !== 'write_file') return false;
  const metadata = toolCall.result?.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const artifactValidation = (metadata as { artifactValidation?: unknown }).artifactValidation;
  if (!artifactValidation || typeof artifactValidation !== 'object') return false;
  return (artifactValidation as { failed?: unknown }).failed === true;
}

/**
 * Enrich the completed label with result data when available.
 * E.g., Grep → t.toolStatus.grepMatches, Glob → t.toolStatus.globFiles
 */
function enrichCompletedLabel(toolCall: ToolCall, defaultLabel: string, t: Translations): string {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return defaultLabel;

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

  return defaultLabel;
}
