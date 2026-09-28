import type { Message } from '../../shared/contract';
import { getSessionManager } from '../services';
import type { TaskManager } from '../task';
import type { RunRegistry } from '../runtime/runRegistry';

type DurableContinuationRegistry = Pick<RunRegistry,
  | 'findRecoveredWaitingRun'
  | 'getDurableCheckpointState'
  | 'resetDurableResumeBudget'
  | 'parkDurable'
>;

type DurableContinuationTaskManager = Pick<TaskManager,
  | 'getSessionState'
  | 'resumeExistingDurableRun'
>;

const continuingSessions = new Set<string>();

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
}): Promise<{ runId: string }> {
  const { sessionId, runRegistry, taskManager } = input;
  if (continuingSessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} is already continuing`);
  }
  continuingSessions.add(sessionId);
  try {
    const recovered = runRegistry.findRecoveredWaitingRun({ sessionId });
    if (!recovered) throw new Error(`No parked durable run is available for session ${sessionId}`);
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
      await runRegistry.parkDurable(recovered.runId, { reason: 'user_stop' }).catch(() => undefined);
      throw error;
    }
    return { runId: recovered.runId };
  } finally {
    continuingSessions.delete(sessionId);
  }
}
