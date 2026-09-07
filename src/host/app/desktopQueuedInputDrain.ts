import type { AgentApplicationService } from '../../shared/contract/appService';
import type { AgentEvent } from '../../shared/contract';
import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
import type { QueuedInputSettledEvent } from '../../shared/contract/queuedInput';
import { QUEUED_INPUT_RETRY } from '../../shared/constants/queuedInput';
import type { TaskManagerEvent } from '../task';
import type { QueuedInputRepository } from '../services/core/repositories/QueuedInputRepository';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DesktopQueuedInputDrain');

interface DesktopDrainTaskManager {
  on(event: 'state_change', listener: (event: TaskManagerEvent) => void): unknown;
  off(event: 'state_change', listener: (event: TaskManagerEvent) => void): unknown;
  getSessionState(sessionId: string): { status: string };
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
  | 'listSessionsWithQueuedInputs'
>;

export interface DesktopQueuedInputDrainHandle {
  dispose: () => void;
  /** 启动期扫描：把重启后仍卡在 queued 的 session 派发出去。只应调用一次，重复调用是幂等的。 */
  runStartupSweep: () => void;
}

export interface DesktopQueuedInputDrainDependencies {
  taskManager: DesktopDrainTaskManager;
  appService: DesktopDrainAppService;
  repository: DesktopDrainRepository;
  /** 出队/重入队/终态时通知前端；缺省则只改 DB（测试夹具可不传）。 */
  notifyQueuedInputSettled?: (settled: QueuedInputSettledEvent) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDesktopQueuedInputDrain({
  taskManager,
  appService,
  repository,
  notifyQueuedInputSettled,
}: DesktopQueuedInputDrainDependencies): DesktopQueuedInputDrainHandle {
  const activeSessions = new Set<string>();
  const pendingIdleSessions = new Set<string>();
  const lastStatusBySession = new Map<string, string>();
  let startupSweepDone = false;

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
      notifyQueuedInputSettled?.({ sessionId, id, status: 'queued' });
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
    notifyQueuedInputSettled?.({ sessionId, id, status: 'failed' });
  };

  const drainOne = async (sessionId: string): Promise<void> => {
    try {
      const record = repository.listBySession(sessionId, 'queued')[0];
      if (!record || !repository.markSending(record.id)) {
        return;
      }
      notifyQueuedInputSettled?.({ sessionId, id: record.id, status: 'sending' });

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
      notifyQueuedInputSettled?.({ sessionId, id: record.id, status: 'consumed' });
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
  return {
    dispose: () => {
      taskManager.off('state_change', onStateChange);
    },
    runStartupSweep: () => {
      if (startupSweepDone) {
        return;
      }
      startupSweepDone = true;

      for (const sessionId of repository.listSessionsWithQueuedInputs()) {
        if (taskManager.getSessionState(sessionId).status !== 'idle') {
          continue;
        }
        scheduleDrain(sessionId);
      }
    },
  };
}
