import type { AgentApplicationService } from '../../shared/contract/appService';
import type { AgentEvent } from '../../shared/contract';
import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
import { QUEUED_INPUT_RETRY } from '../../shared/constants/queuedInput';
import type { TaskManagerEvent } from '../task';
import type { QueuedInputRepository } from '../services/core/repositories/QueuedInputRepository';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DesktopQueuedInputDrain');

interface DesktopDrainTaskManager {
  on(event: 'state_change', listener: (event: TaskManagerEvent) => void): unknown;
  off(event: 'state_change', listener: (event: TaskManagerEvent) => void): unknown;
  emitAgentEventForSession(
    sessionId: string,
    event: AgentEvent,
  ): void;
}

type DesktopDrainAppService = Pick<AgentApplicationService, 'sendMessage'>;

type DesktopDrainRepository = Pick<
  QueuedInputRepository,
  | 'listBySession'
  | 'markSending'
  | 'markConsumed'
  | 'requeueAfterFailure'
  | 'markFailed'
>;

export interface DesktopQueuedInputDrainDependencies {
  taskManager: DesktopDrainTaskManager;
  appService: DesktopDrainAppService;
  repository: DesktopDrainRepository;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDesktopQueuedInputDrain({
  taskManager,
  appService,
  repository,
}: DesktopQueuedInputDrainDependencies): () => void {
  const activeSessions = new Set<string>();
  const pendingIdleSessions = new Set<string>();
  const lastStatusBySession = new Map<string, string>();

  const scheduleDrain = (sessionId: string): void => {
    activeSessions.add(sessionId);
    queueMicrotask(() => {
      void drainOne(sessionId).catch((error) => {
        logger.error('Desktop queued input drain failed', error);
      });
    });
  };

  const settleSendFailure = (sessionId: string, id: string, error: unknown): void => {
    const requeued = repository.requeueAfterFailure(id);
    if (!requeued) {
      logger.warn('Queued input could not be requeued after send failure', { sessionId, id });
      return;
    }

    if (requeued.retryCount <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS) {
      return;
    }

    if (!repository.markFailed(id)) {
      logger.warn('Queued input could not transition to failed after retry exhaustion', {
        sessionId,
        id,
        retryCount: requeued.retryCount,
      });
      return;
    }

    taskManager.emitAgentEventForSession(sessionId, {
      type: 'error',
      data: {
        code: 'QUEUED_INPUT_SEND_FAILED',
        message: errorMessage(error),
      },
    });
  };

  const drainOne = async (sessionId: string): Promise<void> => {
    try {
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
        settleSendFailure(sessionId, record.id, error);
        return;
      }

      try {
        await appService.sendMessage(envelope);
      } catch (error) {
        settleSendFailure(sessionId, record.id, error);
        return;
      }

      if (!repository.markConsumed(record.id)) {
        logger.warn('Queued input could not transition to consumed after send success', {
          sessionId,
          id: record.id,
        });
      }
    } finally {
      activeSessions.delete(sessionId);
      if (pendingIdleSessions.delete(sessionId)) {
        scheduleDrain(sessionId);
      }
    }
  };

  const onStateChange = (event: TaskManagerEvent): void => {
    const status = (event.data as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'string') {
      return;
    }

    const previousStatus = lastStatusBySession.get(event.sessionId);
    lastStatusBySession.set(event.sessionId, status);
    if (status !== 'idle' || previousStatus === 'idle') {
      return;
    }

    if (activeSessions.has(event.sessionId)) {
      pendingIdleSessions.add(event.sessionId);
      return;
    }

    scheduleDrain(event.sessionId);
  };

  taskManager.on('state_change', onStateChange);
  return () => {
    taskManager.off('state_change', onStateChange);
  };
}
