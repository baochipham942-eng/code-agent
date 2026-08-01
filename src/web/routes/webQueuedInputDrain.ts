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
  | 'listSessionsWithQueuedInputs'
>;

interface WebQueuedInputDrainDependencies {
  getRepository: () => WebQueuedInputDrainRepository;
  hasActiveRun: (sessionId: string) => boolean;
  runEnvelope: (envelope: ConversationEnvelope, response: Response) => Promise<void>;
  emitAgentEvent: (sessionId: string, event: AgentEvent) => void;
  /**
   * 一条排队消息在宿主侧走完（消费/失败）后通知前端。
   * 前端的排队卡片是本地 React state，只有「立即发送」那条路会自己清；
   * 宿主自动抽干时前端完全不知情，卡片就永远留着，点撤回还会被如实告知
   * 「已经开始发送」——用户看到的就是「没发出去又删不掉」。
   */
  notifyQueuedInputSettled: (
    settled: { sessionId: string; id: string; status: 'consumed' | 'failed' },
  ) => void;
  logger: WebRouteLogger;
}

export interface WebQueuedInputDrain {
  handleReleasedSession(sessionId: string): void;
  /**
   * 一条消息刚入队。若此刻这个 session 已经没有活跃 run，就得立刻抽——否则它会
   * 一直躺在队列里没人管：release 时的那次 drain 早跑完了，而入队发生在那之后。
   * 真机 2026-08-01：上一轮刚回复完就发下一条，消息进了排队卡但模型再也不回。
   */
  handleEnqueued(sessionId: string): void;
  runStartupSweep(): void;
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
  hasActiveRun,
  runEnvelope,
  emitAgentEvent,
  notifyQueuedInputSettled,
  logger,
}: WebQueuedInputDrainDependencies): WebQueuedInputDrain {
  const activeSessions = new Set<string>();
  const pendingReleasedSessions = new Set<string>();
  let startupSweepDone = false;

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
    notifyQueuedInputSettled({ sessionId, id, status: 'failed' });
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
      notifyQueuedInputSettled({ sessionId, id: record.id, status: 'consumed' });
    } finally {
      activeSessions.delete(sessionId);
      if (pendingReleasedSessions.delete(sessionId)) {
        scheduleDrain(sessionId);
      }
    }
  };

  return {
    handleEnqueued(sessionId: string): void {
      // 有 run 在跑就什么都不做：那才是「排到下一轮」的正常语义，
      // 由 release 时的 drain 负责。
      if (hasActiveRun(sessionId)) return;
      if (activeSessions.has(sessionId)) {
        pendingReleasedSessions.add(sessionId);
        return;
      }
      scheduleDrain(sessionId);
    },
    handleReleasedSession(sessionId: string): void {
      if (activeSessions.has(sessionId)) {
        pendingReleasedSessions.add(sessionId);
        return;
      }
      scheduleDrain(sessionId);
    },
    runStartupSweep(): void {
      if (startupSweepDone) {
        return;
      }
      startupSweepDone = true;

      for (const sessionId of getRepository().listSessionsWithQueuedInputs()) {
        if (hasActiveRun(sessionId)) {
          continue;
        }
        scheduleDrain(sessionId);
      }
    },
  };
}
