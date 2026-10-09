import type { Response } from 'express';
import type { AgentEvent } from '../../shared/contract';
import type { DelegationOriginMarker, QueuedInputActivatedEvent } from '../../shared/contract/queuedInput';
import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
import { QUEUED_INPUT_RETRY } from '../../shared/constants/queuedInput';
import type { QueuedInputRepository, QueuedInputRecord } from '../../host/services/core/repositories/QueuedInputRepository';
import { RunSessionConflictError } from '../../host/runtime/runRegistry';
import type { DelegationClaimDecision } from '../../host/services/delegation/delegationDelivery';
import type { WebRouteLogger } from './routeTypes';

type WebQueuedInputDrainRepository = Pick<
  QueuedInputRepository,
  | 'getNextDispatchable'
  | 'markSending'
  | 'markConsumed'
  | 'requeueAfterFailure'
  | 'markFailed'
  | 'pauseQueued'
  | 'listSessionsWithQueuedInputs'
  | 'recoverSendingOrphans'
>;

/**
 * ADR-072 K1C 委托投递钩子（可选，缺省 = 现行为）：beforeClaim 必须先于
 * markSending（INV-1）；pause 时本行写 paused_reason 并继续抽下一行（I4）；
 * onActivated 回填 target_run_id（INV-4）；冲突暂停不重试；重试耗尽投影
 * aborted(delivery_failed)；projectTerminal 做终态投影（幂等）。
 */
export interface WebQueuedInputDrainDelegation {
  beforeClaim(record: QueuedInputRecord): Promise<DelegationClaimDecision> | DelegationClaimDecision;
  onActivated(record: QueuedInputRecord, activation: { runId: string; activatedAt: number }): void;
  onClaimConflict(record: QueuedInputRecord): void;
  onRetryExhausted(record: QueuedInputRecord): void;
  projectTerminal(sessionId?: string): void;
}

interface WebQueuedInputDrainDependencies {
  getRepository: () => WebQueuedInputDrainRepository;
  hasActiveRun: (sessionId: string) => boolean;
  runEnvelope: (
    envelope: ConversationEnvelope,
    response: Response,
    onActivated: (activation: Omit<QueuedInputActivatedEvent, 'id' | 'sessionId'>) => void,
    options?: { delegationOrigin?: DelegationOriginMarker },
  ) => Promise<void>;
  emitAgentEvent: (sessionId: string, event: AgentEvent) => void;
  /**
   * 排队条目可见性变化时通知前端。
   * 前端的排队卡片是本地 React state，只有「立即发送」那条路会自己清；
   * 宿主自动抽干时必须在 queued→sending 那一刻就广播，否则回答已经在出、
   * 「排队中 · 1」还挂着同一条。
   */
  notifyQueuedInputSettled: (
    settled: { sessionId: string; id: string; status: 'consumed' | 'failed' | 'sending' | 'queued' },
  ) => void;
  notifyQueuedInputActivated: (activated: QueuedInputActivatedEvent) => void;
  /** 委托行专属行为；不传时 drain 对一切行按既有用户输入语义处理。 */
  delegation?: WebQueuedInputDrainDelegation;
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
  notifyQueuedInputActivated,
  delegation,
  logger,
}: WebQueuedInputDrainDependencies): WebQueuedInputDrain {
  const activeSessions = new Set<string>();
  const pendingReleasedSessions = new Set<string>();
  let startupSweepDone = false;

  const settleRunFailure = (
    repository: WebQueuedInputDrainRepository,
    sessionId: string,
    record: QueuedInputRecord,
    error: unknown,
  ): void => {
    const { id } = record;
    const requeued = repository.requeueAfterFailure(id);
    if (!requeued) {
      logger.warn('Web queued input could not be requeued after run failure', { sessionId, id });
      return;
    }

    if (requeued.retryCount <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS) {
      notifyQueuedInputSettled({ sessionId, id, status: 'queued' });
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

    delegation?.onRetryExhausted(record);

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
      const record = repository.getNextDispatchable(sessionId);
      if (!record) {
        return;
      }
      // INV-1：先复核再抢占。无 delegation 钩子（旧行为）或普通用户行走 markSending 直投。
      let delegationOrigin: DelegationOriginMarker | undefined;
      if (delegation) {
        const decision = await delegation.beforeClaim(record);
        if (decision.kind === 'wait') {
          return;
        }
        if (decision.kind === 'pause') {
          if (!repository.pauseQueued(record.id, decision.code)) {
            return;
          }
          notifyQueuedInputSettled({ sessionId, id: record.id, status: 'queued' });
          // I4：本行暂停不停摆，继续抽同会话的下一行。
          scheduleDrain(sessionId);
          return;
        }
        delegationOrigin = decision.delegationOrigin;
      }
      if (!repository.markSending(record.id)) {
        return;
      }
      notifyQueuedInputSettled({ sessionId, id: record.id, status: 'sending' });

      let envelope: ConversationEnvelope;
      try {
        envelope = {
          ...(JSON.parse(record.envelopeJson) as ConversationEnvelope),
          clientMessageId: record.id,
          sessionId: record.sessionId,
        };
      } catch (error) {
        settleRunFailure(repository, sessionId, record, error);
        return;
      }

      try {
        await runEnvelope(
          envelope,
          createOfflineAgentRunResponseSink(),
          (activation) => {
            delegation?.onActivated(record, activation);
            notifyQueuedInputActivated({
              id: record.id,
              sessionId,
              ...activation,
            });
          },
          delegationOrigin ? { delegationOrigin } : undefined,
        );
      } catch (error) {
        if (delegationOrigin && error instanceof RunSessionConflictError) {
          // 抢占后才发现目标已有活跃 run：暂停不进自动重试（INV-3）。
          delegation?.onClaimConflict(record);
          notifyQueuedInputSettled({ sessionId, id: record.id, status: 'queued' });
          return;
        }
        settleRunFailure(repository, sessionId, record, error);
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
      delegation?.projectTerminal(sessionId);
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

      getRepository().recoverSendingOrphans();
      // 停机期间目标 run 已终态的委托行在这里补写 terminal_observed（幂等、可重放）。
      delegation?.projectTerminal();

      for (const sessionId of getRepository().listSessionsWithQueuedInputs()) {
        if (hasActiveRun(sessionId)) {
          continue;
        }
        scheduleDrain(sessionId);
      }
    },
  };
}
