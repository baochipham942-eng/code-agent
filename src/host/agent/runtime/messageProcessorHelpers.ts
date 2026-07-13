import type { ToolCall, ToolResult } from '../../../shared/contract';
import {
  sanitizeBrowserComputerToolArguments,
  sanitizeBrowserComputerToolResult,
  sanitizeLargeTextToolArguments,
} from '../../../shared/utils/browserComputerRedaction';
import type { RuntimeContext } from './runtimeContext';
import type { ArtifactRepairToolPolicy } from './artifactRepairGuard';

export function sanitizeToolArgumentsForObservation(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): Record<string, unknown> | undefined {
  const browserSafeArgs = sanitizeBrowserComputerToolArguments(toolCall.name, toolCall.arguments) || toolCall.arguments;
  return sanitizeLargeTextToolArguments(toolCall.name, browserSafeArgs);
}

export function sanitizeToolResultForObservation(
  toolCall: Pick<ToolCall, 'name' | 'arguments'> | undefined,
  result: ToolResult,
): ToolResult {
  if (!toolCall) {
    return result;
  }
  return sanitizeBrowserComputerToolResult(toolCall.name, toolCall.arguments, result);
}

export function shouldPreserveToolObservation(result: ToolResult): boolean {
  return result.metadata?.preserveObservation === true || result.metadata?.observationKind === 'computer_surface_read';
}

export function isArtifactRepairTargetFileRead(result: ToolResult): boolean {
  return result.success === true
    && typeof result.output === 'string'
    && result.metadata?.evidenceKind === 'file_read'
    && typeof result.metadata?.filePath === 'string';
}

export function buildForcedFinalAssistantContent(reason: string): string {
  if (reason.includes('artifact repair target already passes validation')) {
    return '目标产物已通过交互验收，修复流程已结束。';
  }
  return '任务已结束，已停止继续调用工具。执行记录和产物已保留。';
}

export function shouldDeferForcedFinalToInference(ctx: RuntimeContext): boolean {
  const reason = ctx.control.forceFinalResponseReason ?? '';
  const prompt = ctx.control.forceFinalResponsePrompt ?? '';
  return reason.startsWith('连续只读操作达到硬阈值')
    || prompt.includes('reason="read-loop-hard-limit"');
}

export function buildArtifactRepairAdmissionRecoveryPrompt(
  targetFile: string,
  requestedNames: string,
  allowedNames: string,
  policy: ArtifactRepairToolPolicy | null = null,
): string {
  const mutationTools = policy?.mutationToolPrompt || 'currently available file mutation tools';
  return [
    '<artifact-repair-admission-blocked>',
    `You are already inside artifact repair mode for ${targetFile}.`,
    `Your previous tool call requested unavailable tools: ${requestedNames}.`,
    `Only these tools are currently available: ${allowedNames}.`,
    'Do not repeat the unavailable tool call.',
    `Your next action must patch the target artifact with ${mutationTools} — prefer one complete Write of the whole self-contained HTML.`,
    'Use the target HTML file and validator failure summary already in context. Do not inspect validator/runtime sources.',
    '</artifact-repair-admission-blocked>',
  ].join('\n');
}

export function isArtifactDirectoryBootstrapOnly(toolCall: ToolCall, result: ToolResult): boolean {
  if (!result.success) return false;
  if (toolCall.name !== 'Bash' && toolCall.name !== 'bash') return false;
  const command = typeof toolCall.arguments?.command === 'string' ? toolCall.arguments.command.trim() : '';
  if (!command) return false;
  return /^mkdir\s+-p\s+/.test(command);
}
