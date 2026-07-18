import type { Response } from 'express';
import type { AgentEvent } from '../../shared/contract';
import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
import { QUEUED_INPUT_RETRY } from '../../shared/constants/queuedInput';
import type { QueuedInputRepository } from '../../host/services/core/repositories/QueuedInputRepository';
import type { WebRouteLogger } from './routeTypes';

type WebQueuedInputDrainRepository = Pick<
  QueuedInputRepository,
  | 'listBySession'
  | 'markSending'
  | 'markConsumed'
  | 'requeueAfterFailure'
  | 'markFailed'
>;

interface WebQueuedInputDrainDependencies {
  getRepository: () => WebQueuedInputDrainRepository;
  runEnvelope: (envelope: ConversationEnvelope, response: Response) => Promise<void>;
  emitAgentEvent: (sessionId: string, event: AgentEvent) => void;
  logger: WebRouteLogger;
}

export interface WebQueuedInputDrain {
  handleReleasedSession(sessionId: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Minimal write-only sink for a host-owned web run. It deliberately implements
 * only the response surface used by AgentRunController/sendSSE.
 */
export function createOfflineAgentRunResponseSink(): Response {
  let writableEnded = false;
  const sink = {
    get writableEnded(): boolean {
      return writableEnded;
    },
    destroyed: false,
    write: () => true,
    end: () => {
      writableEnded = true;
      return sink;
    },
    once: () => sink,
    off: () => sink,
  };
  return sink as unknown as Response;
}

export async function releaseThenTriggerWebQueuedInputDrain(input: {
  release: () => Promise<void>;
  sessionId: string;
  triggerDrain: (sessionId: string) => void;
}): Promise<void> {
  await input.release();
  input.triggerDrain(input.sessionId);
}

export function createWebQueuedInputDrain({
  getRepository,
  runEnvelope,
  emitAgentEvent,
  logger,
}: WebQueuedInputDrainDependencies): WebQueuedInputDrain {
  const activeSessions = new Set<string>();
  const pendingReleasedSessions = new Set<string>();

  const settleRunFailure = (
    repository: WebQueuedInputDrainRepository,
    sessionId: string,
    id: string,
    error: unknown,
  ): void => {
    const requeued = repository.requeueAfterFailure(id);
    if (!requeued) {
      logger.warn('Web queued input could not be requeued after run failure', { sessionId, id });
      return;
    }

    if (requeued.retryCount <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS) {
      return;
    }

    if (!repository.markFailed(id)) {
      logger.warn('Web queued input could not transition to failed after retry exhaustion', {
        sessionId,
        id,
        retryCount: requeued.retryCount,
      });
      return;
    }

    emitAgentEvent(sessionId, {
      type: 'error',
      data: {
        code: 'QUEUED_INPUT_SEND_FAILED',
        message: errorMessage(error),
      },
    });
  };

  const scheduleDrain = (sessionId: string): void => {
    activeSessions.add(sessionId);
    queueMicrotask(() => {
      void drainOne(sessionId).catch((error) => {
        logger.error('Web queued input drain failed', error);
      });
    });
  };

  const drainOne = async (sessionId: string): Promise<void> => {
    try {
      const repository = getRepository();
      const record = repository.listBySession(sessionId, 'queued')[0];
      if (!record || !repository.markSending(record.id)) {
        return;
      }

      let envelope: ConversationEnvelope;
      try {
        envelope = {
          ...(JSON.parse(record.envelopeJson) as ConversationEnvelope),
          clientMessageId: record.id,
          sessionId: record.sessionId,
        };
      } catch (error) {
        settleRunFailure(repository, sessionId, record.id, error);
        return;
      }

      try {
        await runEnvelope(envelope, createOfflineAgentRunResponseSink());
      } catch (error) {
        settleRunFailure(repository, sessionId, record.id, error);
        return;
      }

      if (!repository.markConsumed(record.id)) {
        logger.warn('Web queued input could not transition to consumed after run success', {
          sessionId,
          id: record.id,
        });
      }
    } finally {
      activeSessions.delete(sessionId);
      if (pendingReleasedSessions.delete(sessionId)) {
        scheduleDrain(sessionId);
      }
    }
  };

  return {
    handleReleasedSession(sessionId: string): void {
      if (activeSessions.has(sessionId)) {
        pendingReleasedSessions.add(sessionId);
        return;
      }
      scheduleDrain(sessionId);
    },
  };
}
