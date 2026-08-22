import type { AgentTreeNode } from '@shared/contract/agentTree';
import type { LastToolStep, Task, TaskOutputRef } from '@shared/contract/backgroundTask';
import type { ToolCall } from '@shared/contract';

export type DelegationReceiptState = 'working' | 'completed' | 'failed';

export interface DelegationReceiptOutput {
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
}

const TASK_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired', 'orphaned']);
const AGENT_FAILED = new Set(['failed', 'cancelled', 'killed', 'blocked', 'dead-log-only']);

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
  const terminal = TASK_TERMINAL.has(task.status);
  const state: DelegationReceiptState = !terminal
    ? 'working'
    : task.status === 'completed'
      ? 'completed'
      : 'failed';
  return {
    state,
    title: task.title,
    lastToolStep: task.progress?.lastToolStep,
    stepCount: terminal
      ? completedStepCount(task.progress?.lastToolStep, task.progress?.current)
      : undefined,
    outputs: task.outputRefs.flatMap((ref) => {
      const output = taskOutput(ref);
      return output ? [output] : [];
    }),
    failure: state === 'failed' ? task.failure?.message || task.summary : undefined,
  };
}

export function extractSpawnAgentId(toolCall: ToolCall): string | undefined {
  const metadataAgentId = toolCall.result?.metadata?.agentId;
  if (typeof metadataAgentId === 'string' && metadataAgentId.trim()) return metadataAgentId.trim();
  const match = toolCall.result?.output?.match(/^- Agent ID:\s*(\S+)\s*$/m);
  return match?.[1];
}

function fromAgent(node: AgentTreeNode): DelegationPresentation {
  const state: DelegationReceiptState = node.status === 'completed'
    ? 'completed'
    : AGENT_FAILED.has(node.status)
      ? 'failed'
      : 'working';
  const terminal = state !== 'working';
  return {
    state,
    title: node.task?.trim() || node.role,
    lastToolStep: node.lastToolStep,
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
