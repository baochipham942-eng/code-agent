import type { ToolCall } from '@shared/contract';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolStatus } from '../components/features/chat/MessageBubble/ToolCallDisplay/styles';
import type { ToolCapabilitySource } from '../types/runWorkbench';

export type ToolPermissionView =
  | 'read'
  | 'write'
  | 'shell'
  | 'network'
  | 'desktop'
  | 'memory'
  | 'mcp'
  | 'unknown';

export interface ToolLoopDecisionSummary {
  action: string;
  reason: string;
  expectedNextAction: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}

export interface ToolLikeForDecision {
  name: string;
  shortDescription?: string;
  expectedOutcome?: string;
  result?: unknown;
  success?: boolean;
  _streaming?: boolean;
  metadata?: Record<string, unknown> | null;
}

/**
 * 判定一条工具结果是否「自动加载重试」的良性内部状态（success:false 但不是真失败）。
 * 源头：messageProcessorUnavailableTools.ts —— 工具未加载→自动加载→让模型重试。
 * UI 各消费方据此不当失败处理，避免假失败污染状态/计数/决策 chip。
 */
export function isAutoLoadedRetry(metadata?: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return metadata.autoLoaded === true || metadata.autoLoadedTools != null;
}

const WRITE_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'edit_file',
  'write_file',
  'apply_patch',
]);

const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'list_directory',
]);

export function getToolCapabilitySource(toolName: string): ToolCapabilitySource {
  const lower = toolName.toLowerCase();
  if (lower.startsWith('mcp__') || lower.includes('mcp')) return 'mcp';
  if (lower.includes('skill')) return 'skill';
  if (lower.includes('connector') || lower.includes('mail') || lower.includes('calendar')) return 'connector';
  if (lower.includes('computer') || lower.includes('browser')) return 'computer';
  if (lower.includes('memory')) return 'memory';
  return 'builtin';
}

export function getToolPermissionView(toolName: string): ToolPermissionView {
  const lower = toolName.toLowerCase();
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  if (lower === 'bash' || lower.includes('exec') || lower.includes('shell')) return 'shell';
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('search')) return 'network';
  if (lower.includes('computer') || lower.includes('browser')) return 'desktop';
  if (lower.includes('memory')) return 'memory';
  if (lower.startsWith('mcp__') || lower.includes('mcp')) return 'mcp';
  return 'unknown';
}

export function formatToolDuration(duration?: number): string | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  if (duration < 1000) return `${Math.round(duration)}ms`;
  const seconds = duration / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function getToolRecoveryHint(toolCall: ToolCall, status: ToolStatus): string {
  if (status === 'pending') return '等待结果';
  if (status === 'interrupted') return '可重新运行';
  if (status === 'error') {
    if (toolCall.expectedOutcome) return `恢复：${toolCall.expectedOutcome}`;
    return '查看输出后重试或换工具';
  }
  if (toolCall.result?.outputPath) return '产物已记录';
  return '结果已记录';
}

function bestToolReason(tool: ToolLikeForDecision): string {
  return tool.expectedOutcome || tool.shortDescription || tool.name;
}

export function summarizeToolLoopDecision(allTools: ToolLikeForDecision[]): ToolLoopDecisionSummary | null {
  // 自动加载重试是良性内部状态，决策判定里完全忽略它——否则会被误判成失败弹「暂停恢复」。
  const tools = allTools.filter((tool) => !isAutoLoadedRetry(tool.metadata));
  if (tools.length === 0) return null;

  const failed = tools.find((tool) => tool.success === false);
  if (failed) {
    return {
      action: '暂停恢复',
      reason: bestToolReason(failed),
      expectedNextAction: '查看错误输出，必要时换工具或重试',
      tone: 'error',
    };
  }

  const pending = tools.find((tool) => tool._streaming || tool.result === undefined);
  if (pending) {
    return {
      action: '等待工具返回',
      reason: bestToolReason(pending),
      expectedNextAction: '收到结果后继续汇总或执行下一步',
      tone: 'neutral',
    };
  }

  return {
    action: tools.length > 1 ? `完成 ${tools.length} 个工具调用` : '工具结果已返回',
    reason: bestToolReason(tools[0]),
    expectedNextAction: '把结果并入回复或继续下一步',
    tone: 'success',
  };
}

export function summarizeToolLoopDecisionFromNodes(nodes: TraceNode[]): ToolLoopDecisionSummary | null {
  const tools: ToolLikeForDecision[] = nodes
    .map((node) => node.toolCall)
    .filter((toolCall): toolCall is NonNullable<TraceNode['toolCall']> => Boolean(toolCall))
    .map((toolCall) => ({
      name: toolCall.name,
      shortDescription: toolCall.shortDescription,
      expectedOutcome: toolCall.expectedOutcome,
      result: toolCall.result,
      success: toolCall.success,
      _streaming: toolCall._streaming,
      metadata: toolCall.metadata,
    }));

  return summarizeToolLoopDecision(tools);
}
