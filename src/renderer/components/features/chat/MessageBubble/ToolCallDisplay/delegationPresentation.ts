import type { AgentTreeNode } from '@shared/contract/agentTree';
import type { LastToolFailure, LastToolStep, Task, TaskOutputRef } from '@shared/contract/backgroundTask';
import type { ToolCall } from '@shared/contract';
import {
  isAgentNodeTerminalStatus,
  isLastToolFailureVisible,
  isTaskTerminalStatus,
  taskActivityIds,
} from '../../../../../utils/agentActivity';

type DelegationReceiptState = 'working' | 'completed' | 'failed';

interface DelegationReceiptOutput {
  id: string;
  label: string;
  target: string;
  kind: 'file' | 'url';
}

export interface DelegationPresentation {
  state: DelegationReceiptState;
  title: string;
  lastToolStep?: LastToolStep;
  stepCount?: number;
  outputs: DelegationReceiptOutput[];
  failure?: string;
  /** 终态任务的结构化工具失败（N-MEDIA-GEN-MUSIC-FALLBACK-FU1）：回执行人话出路用。 */
  toolFailure?: LastToolFailure;
  /** 审批关联键（agentRows.applyMemberHolds 同口径）：task.id / runId / childRunId 或节点 id。 */
  activityIds: readonly string[];
  /** 任务归属会话；agentTree 节点路径没有，审批作用域由 resolveAgentActivityStepStatus 兜底。 */
  sessionId?: string;
}

function basename(value: string): string {
  const normalized = value.split(/[?#]/, 1)[0] || value;
  return normalized.split(/[\\/]/).filter(Boolean).pop() || value;
}

function taskOutput(ref: TaskOutputRef): DelegationReceiptOutput | undefined {
  const target = ref.path || ref.uri;
  if (!target) return undefined;
  return {
    id: ref.id,
    label: basename(target) || ref.label || target,
    target,
    kind: ref.path ? 'file' : 'url',
  };
}

function completedStepCount(step: LastToolStep | undefined, current: number | undefined): number | undefined {
  const indexed = step?.toolIndex === undefined ? undefined : step.toolIndex + 1;
  const count = Math.max(current ?? 0, indexed ?? 0);
  return count > 0 ? count : undefined;
}

function fromTask(task: Task): DelegationPresentation {
  const terminal = isTaskTerminalStatus(task.status);
  const state: DelegationReceiptState = !terminal
    ? 'working'
    : task.status === 'completed'
      ? 'completed'
      : 'failed';
  return {
    state,
    title: task.title,
    lastToolStep: task.progress?.lastToolStep,
    activityIds: taskActivityIds(task),
    sessionId: task.sessionId,
    stepCount: terminal
      ? completedStepCount(task.progress?.lastToolStep, task.progress?.current)
      : undefined,
    outputs: task.outputRefs.flatMap((ref) => {
      const output = taskOutput(ref);
      return output ? [output] : [];
    }),
    failure: state === 'failed' ? task.failure?.message || task.summary : undefined,
    toolFailure: isLastToolFailureVisible(task.status) ? task.progress?.lastToolFailure : undefined,
  };
}

function extractSpawnAgentId(toolCall: ToolCall): string | undefined {
  const metadataAgentId = toolCall.result?.metadata?.agentId;
  if (typeof metadataAgentId === 'string' && metadataAgentId.trim()) return metadataAgentId.trim();
  const match = toolCall.result?.output?.match(/^- Agent ID:\s*(\S+)\s*$/m);
  return match?.[1];
}

function fromAgent(node: AgentTreeNode): DelegationPresentation {
  const state: DelegationReceiptState = node.status === 'completed'
    ? 'completed'
    : isAgentNodeTerminalStatus(node.status)
      ? 'failed'
      : 'working';
  const terminal = state !== 'working';
  return {
    state,
    title: node.task?.trim() || node.role,
    lastToolStep: node.lastToolStep,
    activityIds: [node.id],
    stepCount: terminal ? completedStepCount(node.lastToolStep, undefined) : undefined,
    outputs: node.evidenceRefs.flatMap((ref) => {
      if (ref.kind !== 'file' && ref.kind !== 'artifact') return [];
      return [{
        id: ref.id,
        label: basename(ref.ref),
        target: ref.ref,
        kind: ref.ref.startsWith('http://') || ref.ref.startsWith('https://') ? 'url' as const : 'file' as const,
      }];
    }),
    failure: state === 'failed' ? node.failureReason || node.progress : undefined,
  };
}

export function deriveDelegationPresentation(
  toolCall: ToolCall,
  tasks: Task[],
  agentNodes: AgentTreeNode[],
): DelegationPresentation | null {
  if (!toolCall.result) return null;
  if (toolCall.name === 'delegate_task') {
    const task = tasks.find((candidate) => candidate.toolCallId === toolCall.id);
    return task ? fromTask(task) : null;
  }
  if (toolCall.name === 'spawn_agent') {
    const agentId = extractSpawnAgentId(toolCall);
    if (!agentId) return null;
    const node = agentNodes.find((candidate) => candidate.id === agentId);
    return node ? fromAgent(node) : null;
  }
  return null;
}

export function resolveAgentActivityTarget(
  step: LastToolStep | undefined,
  agentNodes: AgentTreeNode[],
): LastToolStep | undefined {
  if (!step?.target) return step;
  const peer = agentNodes.find((candidate) => candidate.id === step.target);
  return peer ? { ...step, target: peer.role } : step;
}
