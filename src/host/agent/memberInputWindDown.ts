// ============================================================================
// 原生子代理收尾：补话续跑 + 残留计数（N-MEMBER-INPUT-DROP）
// ----------------------------------------------------------------------------
// 只看 SpawnGuard 与协调器两份活队列。队友收件箱没有 markRead，叠进去会永远非空。
// 协调器只取注册表里已有的，不在这里新建。
// ============================================================================

import { agentFailureCodeFromCancellationReason, inferAgentFailureCode } from '../../shared/contract/agentFailure';
import { normalizeCancellationReason, type CancellationReason } from '../../shared/contract/cancellation';
import type { SwarmRunScope } from '../../shared/contract/swarm';
import { generateMessageId } from '../../shared/utils/id';
import { collectTurnOrigins, type AgentMessage, type AgentMessageOrigin } from './messageOrigin';
import { getParallelAgentCoordinatorRegistry } from './parallelAgentCoordinatorRegistry';
import { LEGACY_COORDINATOR_SCOPE } from './parallelAgentCoordinatorTypes';
import { getSpawnGuard } from './spawnGuard';
import { buildObservation, createRuntimeMessage, type RuntimeMessage } from './subagentExecutorProjection';
import type { SubagentContext, SubagentResult } from './subagentExecutorTypes';
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

function resolveSubagentWindDown(input: {
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

/** 循环结束后仍堆在队列里的用户补话，写进结果，父代理完成通知跟着这句走。 */
function noteUndeliveredMemberInput(output: string, count: number): string {
  if (count <= 0) return output;
  const line = `用户的 ${count} 条补话未送达该成员`;
  return output ? `${output}\n${line}` : line;
}

type MemberAnswerLedger = {
  rememberAnswer(text: string): void;
  noteDrained(count: number): void;
  settled(): string;
  failureExit(error: unknown, exit: {
    signalAborted: boolean;
    signalReason: unknown;
    toolsUsed: string[];
    toolCallCount: number;
    iterations: number;
    tokensUsed: number;
    cost: number;
    agentId: string;
    contextSnapshot: SubagentResult['contextSnapshot'];
  }): SubagentResult | undefined;
};

/** 答案兜底 + 已排空未答的补话。下一份文本答案会覆盖兜底并清掉这笔账。 */
export function createMemberAnswerLedger(agentId: string | undefined, scope?: SwarmRunScope): MemberAnswerLedger {
  let finalOutput = '';
  let drainedUnanswered = 0;
  const settled = (): string => noteUndeliveredMemberInput(finalOutput, peekMemberInputQueues(agentId, scope).length + drainedUnanswered);
  return {
    rememberAnswer(text: string) {
      finalOutput = text;
      drainedUnanswered = 0;
    },
    noteDrained(count: number) {
      if (count > 0) drainedUnanswered += count;
    },
    settled,
    failureExit(error, exit) {
      if (finalOutput.length === 0 && drainedUnanswered === 0) return undefined;
      const output = settled();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const base: SubagentResult = {
        success: false,
        output,
        error: errorMessage,
        toolsUsed: [...new Set(exit.toolsUsed)],
        toolCallCount: exit.toolCallCount,
        iterations: exit.iterations,
        tokensUsed: exit.tokensUsed,
        cost: exit.cost,
        agentId: exit.agentId,
        contextSnapshot: exit.contextSnapshot,
      };
      if (!exit.signalAborted) {
        return { ...base, failureCode: inferAgentFailureCode({ error: errorMessage }) };
      }
      const cancellationReason: CancellationReason = exit.signalReason === 'timeout'
        ? 'timeout'
        : exit.signalReason === 'idle-timeout'
          ? 'idle-timeout'
          : normalizeCancellationReason(exit.signalReason, 'parent-cancel');
      return {
        ...base,
        cancellationReason,
        failureCode: agentFailureCodeFromCancellationReason(cancellationReason)
          ?? inferAgentFailureCode({ error: errorMessage }),
      };
    },
  };
}

/**
 * 文本答案：续跑前先记兜底，正常收尾再覆盖。
 * 最后一轮不再 member-input 续跑，否则 continue 出了循环，这份 content 不会留下。
 */
export function commitMemberTextAnswer(input: {
  ledger: MemberAnswerLedger;
  content: string;
  thinking?: string;
  openTasks: ReadonlyArray<{ id: string; status: string; subject: string }>;
  taskGateReentries: number;
  memberInputReentries: number;
  agentId: string | undefined;
  scope?: SwarmRunScope;
  iterations: number;
  maxIterations: number;
  messages: RuntimeMessage[];
  log: (message: string) => void;
  pushObservabilityMessage: (message: unknown) => void;
  emitContextSnapshot: () => void;
  persistTelemetryTurn: (assistantResponse: string, thinking?: string) => void;
}): { continueLoop: boolean; taskGateReentries: number; memberInputReentries: number } {
  const windDown = resolveSubagentWindDown({
    openTasks: input.openTasks,
    taskGateReentries: input.taskGateReentries,
    memberInputReentries: input.memberInputReentries,
    pendingInput: peekMemberInputQueues(input.agentId, input.scope).length,
  });
  const counters = {
    taskGateReentries: windDown.taskGateReentries,
    memberInputReentries: windDown.memberInputReentries,
  };
  const resumeMemberInput = windDown.action === 'member-input' && input.iterations < input.maxIterations;
  if (windDown.action === 'task-gate' || resumeMemberInput) {
    input.ledger.rememberAnswer(input.content);
    if (windDown.log) input.log(windDown.log);
    if (windDown.content) input.messages.push(createRuntimeMessage({ role: 'user', content: windDown.content }));
    return { continueLoop: true, ...counters };
  }
  input.ledger.rememberAnswer(input.content);
  input.messages.push(createRuntimeMessage({
    role: 'assistant',
    content: input.content,
    observation: buildObservation('recent_turn', 'assistant_response', {
      sourceKind: 'message',
      layer: 'assistant_turn',
    }),
  }));
  input.pushObservabilityMessage({
    id: generateMessageId(),
    role: 'assistant',
    content: input.content,
    timestamp: Date.now(),
  });
  input.emitContextSnapshot();
  input.persistTelemetryTurn(input.content, input.thinking);
  return { continueLoop: false, ...counters };
}

export async function drainQueuedMemberInput(params: {
  context: Pick<SubagentContext, 'messageDrain' | 'ackMessageDrain'>;
  /** 与 peekMemberInputQueues 相同的 id。空则不碰 SpawnGuard 队列。 */
  queueAgentId: string | undefined;
  agentName: string;
  messages: RuntimeMessage[];
  logger: { info: (message: string, ...args: unknown[]) => void; warn?: (message: string, ...args: unknown[]) => void };
  pushObservabilityMessage: (message: unknown) => void;
  emitContextSnapshot: () => void;
  currentTurnOrigin: AgentMessageOrigin[] | undefined;
  /** 从队列取走、模型尚未用文本答上的条数。调用方在下一份答案里清零。 */
  onDrained?: (count: number) => void;
}): Promise<AgentMessageOrigin[] | undefined> {
  const externalMessages = params.context.messageDrain ? await params.context.messageDrain() : [];
  const pendingMessages = [
    ...(params.queueAgentId ? getSpawnGuard().drainMessages(params.queueAgentId) : []),
    ...externalMessages,
  ];
  params.onDrained?.(pendingMessages.length);
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
