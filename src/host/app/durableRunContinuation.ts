import type { Message } from '../../shared/contract';
import { getRunInterruptCause } from '../../shared/contract/durableRun';
import { getSessionManager } from '../services';
import type { TaskManager } from '../task';
import type { RunRegistry } from '../runtime/runRegistry';
import type { RunRehydrationPlan } from '../runtime/durableRunStores';
import { isNativeRecoveryDescriptor } from '../runtime/nativeRecoveryHost';
import { clearQuotaWaitTimer } from '../runtime/quotaWaitTimer';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DurableRunContinuation');

type DurableContinuationRegistry = Pick<RunRegistry,
  | 'findRecoveredWaitingRun'
  | 'getDurableCheckpointState'
  | 'resetDurableResumeBudget'
  | 'parkDurable'
> & {
  getDurableEnvelope?: RunRegistry['getDurableEnvelope'];
};

type DurableContinuationTaskManager = Pick<TaskManager,
  | 'getSessionState'
  | 'resumeExistingDurableRun'
>;

const continuingSessions = new Set<string>();
const continuingRunIds = new Map<string, string>();

/**
 * Continue a parked durable foreground run without creating a new user turn.
 *
 * This is shared by desktop IPC and the web HTTP route so both transports keep
 * the same run-id, source-message, lock, and park-back semantics.
 */
export async function continueParkedDurableRun(input: {
  sessionId: string;
  runRegistry: DurableContinuationRegistry;
  taskManager: DurableContinuationTaskManager;
  getMessages?: (sessionId: string) => Promise<Message[]>;
}): Promise<{ runId: string; alreadyContinuing?: boolean }> {
  const { sessionId, runRegistry, taskManager } = input;
  if (continuingSessions.has(sessionId)) {
    return { runId: continuingRunIds.get(sessionId) ?? '', alreadyContinuing: true };
  }
  continuingSessions.add(sessionId);
  try {
    const recovered = runRegistry.findRecoveredWaitingRun({ sessionId });
    if (!recovered) throw new Error(`No parked durable run is available for session ${sessionId}`);
    continuingRunIds.set(sessionId, recovered.runId);
    const currentStatus = taskManager.getSessionState(sessionId)?.status;
    if (['running', 'paused', 'queued', 'cancelling'].includes(currentStatus ?? '')) {
      throw new Error(`Session ${sessionId} is already ${currentStatus}`);
    }
    const checkpointState = runRegistry.getDurableCheckpointState(recovered.runId);
    if (!checkpointState || typeof checkpointState !== 'object' || !('sourceMessageId' in checkpointState)
      || typeof checkpointState.sourceMessageId !== 'string') {
      throw new Error(`Parked durable run ${recovered.runId} has no resumable source message`);
    }
    const messages = await (input.getMessages ?? ((id) => getSessionManager().getMessages(id)))(sessionId);
    const source = messages.find((message) => message.id === checkpointState.sourceMessageId && message.role === 'user');
    if (!source) throw new Error(`Parked durable run ${recovered.runId} source message is unavailable`);
    const parked = runRegistry.getDurableEnvelope?.(recovered.runId);
    const parkedCause = parked ? getRunInterruptCause(parked) : undefined;
    const quotaDueAt = parkedCause === 'quota_wait' ? parked?.quotaWaitDueAt : undefined;
    clearQuotaWaitTimer(recovered.runId);
    await runRegistry.resetDurableResumeBudget(recovered.runId);
    try {
      await taskManager.resumeExistingDurableRun(
        sessionId,
        recovered.runId,
        messages,
        { mode: 'normal', disableAutoAgent: true },
        source.metadata,
        source.id,
      );
    } catch (error) {
      // 回停失败只降级不吞主错误（下方照常 throw）；但降级本身要留痕，否则 run 停在
      // running 却无人续跑时没有任何线索（降级路径留痕错题本）。
      await runRegistry.parkDurable(
        recovered.runId,
        parkedCause === 'quota_wait'
          ? { reason: 'quota_wait', ...(quotaDueAt !== undefined ? { dueAt: quotaDueAt } : {}) }
          : { reason: 'user_stop' },
      ).catch((parkError: unknown) => {
        logger.warn('[DurableRunContinuation] park-back after failed resume failed', {
          runId: recovered.runId,
          sessionId,
          reason: parkError instanceof Error ? parkError.message : String(parkError),
        });
      });
      throw error;
    }
    return { runId: recovered.runId };
  } finally {
    continuingSessions.delete(sessionId);
    continuingRunIds.delete(sessionId);
  }
}

/**
 * 排队的自动续跑出队前的复核（webServer beforeAutoResume）：run 仍是入队时那一版才续跑；
 * 新消息优先（ADR-075 修订 2026-09-29 ⑤）——源消息之后已有新的 user 消息时旧 run 终态化并跳过，
 * 否则 resumeExistingDurableRun 会直接抛错，排队任务报错丢失。
 */
export async function shouldStartQueuedAutoResume(input: {
  plan: RunRehydrationPlan;
  runRegistry: Pick<RunRegistry, 'getDurableEnvelope' | 'terminalDurable'>;
  getMessages?: (sessionId: string) => Promise<Message[]>;
  now?: number;
}): Promise<boolean> {
  const { plan, runRegistry } = input;
  const current = runRegistry.getDurableEnvelope(plan.envelope.runId);
  if (current?.status !== 'recovering' || (current.autoResumeCount ?? 0) !== (plan.envelope.autoResumeCount ?? 0)) return false;
  return !await supersededByLaterUserMessage(input);
}

async function supersededByLaterUserMessage(input: {
  plan: RunRehydrationPlan;
  runRegistry: Pick<RunRegistry, 'terminalDurable'>;
  getMessages?: (sessionId: string) => Promise<Message[]>;
  now?: number;
}): Promise<boolean> {
  const { plan, runRegistry } = input;
  const descriptor = plan.checkpoint?.state;
  if (!isNativeRecoveryDescriptor(descriptor)) return false;
  const { sessionId, runId } = plan.envelope;
  const messages = (await (input.getMessages ?? ((id) => getSessionManager().getMessages(id)))(sessionId))
    .filter((message) => !message.isMeta && message.visibility !== 'rewound');
  const sourceIndex = messages.findIndex((message) => message.id === descriptor.sourceMessageId && message.role === 'user');
  if (sourceIndex < 0 || !messages.slice(sourceIndex + 1).some((message) => message.role === 'user')) return false;
  const now = input.now ?? Date.now();
  const payload = { sessionId, reason: 'superseded_by_new_message' };
  await runRegistry.terminalDurable(runId, { now, status: 'cancelled', reason: payload.reason, event: { type: 'run_cancelled', payload, recordedAt: now } });
  return true;
}
