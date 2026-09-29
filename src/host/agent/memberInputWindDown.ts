// ============================================================================
// 原生子代理收尾：补话续跑 + 残留计数（N-MEMBER-INPUT-DROP）
// ----------------------------------------------------------------------------
// 只看 SpawnGuard 与协调器两份活队列。队友收件箱没有 markRead，叠进去会永远非空。
// 协调器只取注册表里已有的，不在这里新建。
// ============================================================================

import type { SwarmRunScope } from '../../shared/contract/swarm';
import { collectTurnOrigins, type AgentMessage, type AgentMessageOrigin } from './messageOrigin';
import { getParallelAgentCoordinatorRegistry } from './parallelAgentCoordinatorRegistry';
import { LEGACY_COORDINATOR_SCOPE } from './parallelAgentCoordinatorTypes';
import { getSpawnGuard } from './spawnGuard';
import type { RuntimeMessage } from './subagentExecutorProjection';
import type { SubagentContext } from './subagentExecutorTypes';
import { drainSubagentMessages } from './subagentExecutorTelemetry';

const TASK_GATE_MAX_REENTRIES = 2;
const MEMBER_INPUT_MAX_REENTRIES = 2;

function messageKey(message: AgentMessage): string {
  if (message.id) return `id:${message.id}`;
  return `${message.timestamp}\0${message.from}\0${message.payload}`;
}

export function peekMemberInputQueues(agentId: string | undefined, scope?: SwarmRunScope): AgentMessage[] {
  if (!agentId) return [];
  const guardMessages = getSpawnGuard().peekMessages(agentId);
  const coordinator = getParallelAgentCoordinatorRegistry().get(scope ?? LEGACY_COORDINATOR_SCOPE);
  const coordinatorMessages = coordinator?.peekMessages(agentId) ?? [];
  const seen = new Set<string>();
  const merged: AgentMessage[] = [];
  for (const message of [...guardMessages, ...coordinatorMessages]) {
    const key = messageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

export function resolveSubagentWindDown(input: {
  openTasks: ReadonlyArray<{ id: string; status: string; subject: string }>;
  taskGateReentries: number;
  memberInputReentries: number;
  pendingInput: number;
}): {
  action: 'task-gate' | 'member-input' | 'finish';
  taskGateReentries: number;
  memberInputReentries: number;
  log?: string;
  content?: string;
} {
  if (input.openTasks.length > 0 && input.taskGateReentries < TASK_GATE_MAX_REENTRIES) {
    const taskGateReentries = input.taskGateReentries + 1;
    const taskLines = input.openTasks.map((task) => `- #${task.id} [${task.status}] ${task.subject}`).join('\n');
    return {
      action: 'task-gate',
      taskGateReentries,
      memberInputReentries: input.memberInputReentries,
      log: `taskGate re-entry ${taskGateReentries}/${TASK_GATE_MAX_REENTRIES}: ${input.openTasks.length} open task(s)`,
      content:
        `[taskGate] 你名下还有 ${input.openTasks.length} 个未收口任务：\n${taskLines}\n` +
        `请先用 TaskManager 把它们置为 completed（已完成）或 cancelled（说明原因），再给出最终总结。`,
    };
  }
  if (input.pendingInput > 0 && input.memberInputReentries < MEMBER_INPUT_MAX_REENTRIES) {
    const memberInputReentries = input.memberInputReentries + 1;
    return {
      action: 'member-input',
      taskGateReentries: input.taskGateReentries,
      memberInputReentries,
      log: `member-input re-entry ${memberInputReentries}/${MEMBER_INPUT_MAX_REENTRIES}: ${input.pendingInput} queued message(s)`,
    };
  }
  return {
    action: 'finish',
    taskGateReentries: input.taskGateReentries,
    memberInputReentries: input.memberInputReentries,
  };
}

/** 超过续跑上限后仍堆在队列里的补话，写进结果，父代理完成通知跟着这句走。 */
export function noteUndeliveredMemberInput(output: string, count: number): string {
  if (count <= 0) return output;
  const line = `未送达 ${count} 条`;
  return output ? `${output}\n${line}` : line;
}

export async function drainQueuedMemberInput(params: {
  context: Pick<SubagentContext, 'messageDrain' | 'ackMessageDrain' | 'spawnGuardId'>;
  agentName: string;
  messages: RuntimeMessage[];
  logger: { info: (message: string, ...args: unknown[]) => void; warn?: (message: string, ...args: unknown[]) => void };
  pushObservabilityMessage: (message: unknown) => void;
  emitContextSnapshot: () => void;
  currentTurnOrigin: AgentMessageOrigin[] | undefined;
}): Promise<AgentMessageOrigin[] | undefined> {
  const externalMessages = params.context.messageDrain ? await params.context.messageDrain() : [];
  const pendingMessages = [
    ...(params.context.spawnGuardId ? getSpawnGuard().drainMessages(params.context.spawnGuardId) : []),
    ...externalMessages,
  ];
  const nextOrigin = collectTurnOrigins(pendingMessages) ?? params.currentTurnOrigin;
  const injected = drainSubagentMessages({
    agentName: params.agentName,
    messages: params.messages,
    pendingMessages,
    logger: params.logger,
    pushObservabilityMessage: params.pushObservabilityMessage,
  });
  if (injected > 0) params.emitContextSnapshot();
  if (externalMessages.length > 0) await params.context.ackMessageDrain?.();
  return nextOrigin;
}
