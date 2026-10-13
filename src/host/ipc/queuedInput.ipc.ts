import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import { QueuedInputSchemas } from '../../shared/ipc/schemas';
import type {
  ConversationEnvelope,
  ConversationModelSpec,
} from '../../shared/contract/conversationEnvelope';
import type { DelegationOriginMarker, QueuedInput } from '../../shared/contract/queuedInput';
import { QUEUED_INPUT_RETRY } from '../../shared/constants/queuedInput';
import { defineHandler } from '../platform/ipcRegistry';
import { getDatabase } from '../services/core/databaseService';
import {
  QueuedInputRepository,
  type QueuedInputRecord,
} from '../services/core/repositories/QueuedInputRepository';
import type { QueuedInputDelegationGuard } from '../services/delegation/delegationDrainHooks';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('QueuedInputIPC');

function getRepository(): QueuedInputRepository {
  const db = getDatabase().getDb();
  if (!db) {
    throw new Error('Database is not initialized');
  }
  return new QueuedInputRepository(db);
}

function toQueuedInput(record: QueuedInputRecord, origin?: 'delegation'): QueuedInput {
  return {
    id: record.id,
    sessionId: record.sessionId,
    envelope: JSON.parse(record.envelopeJson) as ConversationEnvelope,
    status: record.status,
    retryCount: record.retryCount,
    position: record.position,
    pausedReason: record.pausedReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(origin ? { origin } : {}),
  };
}

function invalidState(message: string) {
  return {
    success: false as const,
    error: { code: 'INVALID_STATE', message },
  };
}

function reportSendOutcome(
  repository: QueuedInputRepository,
  id: string,
  outcome: 'success' | 'failure',
) {
  if (outcome === 'success') {
    if (!repository.markConsumed(id)) {
      return invalidState(`Queued input is not sending: ${id}`);
    }
    const consumed = repository.getById(id);
    if (!consumed) {
      return invalidState(`Queued input disappeared after send success: ${id}`);
    }
    return {
      success: true,
      data: { status: 'consumed' as const, retryCount: consumed.retryCount },
    } satisfies IPCResponse;
  }

  const requeued = repository.requeueAfterFailure(id);
  if (!requeued) {
    return invalidState(`Queued input is not sending: ${id}`);
  }
  if (requeued.retryCount > QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS) {
    if (!repository.markFailed(id)) {
      return invalidState(`Queued input could not transition to failed: ${id}`);
    }
    return {
      success: true,
      data: { status: 'failed' as const, retryCount: requeued.retryCount },
    } satisfies IPCResponse;
  }
  return {
    success: true,
    data: { status: 'queued' as const, retryCount: requeued.retryCount },
  } satisfies IPCResponse;
}

export interface QueuedInputHandlerDependencies {
  resolveModelSpec?: (sessionId: string) => ConversationModelSpec | undefined;
  /** 入队完成后通知宿主：若该 session 此刻已空闲，宿主要立刻把它抽走。 */
  onEnqueued?: (sessionId: string) => void;
  hasActiveRun?: (sessionId: string) => boolean;
  sendNow?: (input: {
    id: string;
    sessionId: string;
    envelope: ConversationEnvelope;
    /** ADR-072 K1C：经委托行校验的带外标记，只有 sendNow 空闲分支用它起轮。 */
    delegationOrigin?: DelegationOriginMarker;
  }, route: 'active' | 'idle') => Promise<'sent' | 'steered' | 'queued'>;
  /** 委托守卫（ADR-072 K1C）：不传时一切行按既有用户输入语义处理。 */
  delegation?: QueuedInputDelegationGuard;
}

function stampModelSpec(
  envelope: ConversationEnvelope,
  modelSpec: ConversationModelSpec | undefined,
): ConversationEnvelope {
  const { modelSpec: _untrustedModelSpec, ...otherOptions } = envelope.options ?? {};
  const options = modelSpec ? { ...otherOptions, modelSpec } : otherOptions;
  return {
    ...envelope,
    ...(Object.keys(options).length > 0 ? { options } : { options: undefined }),
  };
}

export function registerQueuedInputHandlers(
  ipcMain: IpcMain,
  deps: QueuedInputHandlerDependencies = {},
): void {
  defineHandler(QueuedInputSchemas.REQUEST, async (_event, request) => {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'enqueue': {
          const repository = getRepository();
          const envelope = stampModelSpec(
            payload.envelope,
            deps.resolveModelSpec?.(payload.sessionId),
          );
          const envelopeJson = JSON.stringify(envelope);
          repository.enqueue({
            id: payload.id,
            sessionId: payload.sessionId,
            envelopeJson,
          });
          const record = repository.getById(payload.id);
          if (!record) {
            return {
              success: false,
              error: {
                code: 'QUEUED_INPUT_NOT_FOUND',
                message: `Queued input was not found after enqueue: ${payload.id}`,
              },
            } satisfies IPCResponse;
          }
          deps.onEnqueued?.(payload.sessionId);
          return { success: true, data: toQueuedInput(record) } satisfies IPCResponse;
        }

        case 'list': {
          const repository = getRepository();
          const records = repository.listBySession(payload.sessionId, payload.status);
          return {
            success: true,
            data: records.map((record) => toQueuedInput(
              record,
              deps.delegation?.isDelegationRow(record.id) ? 'delegation' : undefined,
            )),
          } satisfies IPCResponse;
        }

        case 'update': {
          const repository = getRepository();
          const record = repository.getById(payload.id);
          if (record?.status !== 'queued') {
            return invalidState(`Queued input is not editable: ${payload.id}`);
          }
          // INV-5：委托来源行的载荷不可经任何 renderer / IPC 路径覆写。
          if (deps.delegation?.isDelegationRow(payload.id)) {
            return invalidState(`Queued input is a delegation and cannot be edited: ${payload.id}`);
          }
          const envelope = JSON.parse(record.envelopeJson) as ConversationEnvelope;
          const nextEnvelope: ConversationEnvelope = {
            ...envelope,
            content: payload.content,
            ...(payload.attachments !== undefined
              ? { attachments: payload.attachments as ConversationEnvelope['attachments'] }
              : {}),
          };
          const updated = repository.updateEnvelope(
            payload.id,
            JSON.stringify(nextEnvelope),
          );
          const input = updated ? repository.getById(payload.id) : null;
          return {
            success: true,
            data: {
              updated,
              ...(input ? { input: toQueuedInput(input) } : {}),
            },
          } satisfies IPCResponse;
        }

        case 'requeue': {
          const repository = getRepository();
          const existing = repository.getById(payload.id);
          if (existing?.status !== 'failed' && existing?.status !== 'retracted') {
            return invalidState(`Queued input cannot be requeued: ${payload.id}`);
          }
          if (deps.delegation?.isDelegationRow(payload.id)) {
            // INV-6：已撤回的委托行不可复活为委托。failed 委托行重发沿用存量载荷，
            // 只按目标当前模型档重盖 modelSpec（它不进指纹）。
            if (existing.status === 'retracted') {
              return invalidState(`Retracted delegation cannot be requeued: ${payload.id}`);
            }
            const storedEnvelope = stampModelSpec(
              JSON.parse(existing.envelopeJson) as ConversationEnvelope,
              deps.resolveModelSpec?.(existing.sessionId),
            );
            if (!repository.requeue(payload.id, JSON.stringify(storedEnvelope))) {
              return invalidState(`Queued input cannot be requeued: ${payload.id}`);
            }
          } else {
            const envelope = stampModelSpec(
              payload.envelope,
              deps.resolveModelSpec?.(existing.sessionId),
            );
            if (!repository.requeue(payload.id, JSON.stringify(envelope))) {
              return invalidState(`Queued input cannot be requeued: ${payload.id}`);
            }
          }
          const revived = repository.getById(payload.id);
          if (!revived) {
            return invalidState(`Queued input disappeared after requeue: ${payload.id}`);
          }
          deps.onEnqueued?.(revived.sessionId);
          return { success: true, data: toQueuedInput(revived, deps.delegation?.isDelegationRow(payload.id) ? 'delegation' : undefined) } satisfies IPCResponse;
        }

        case 'reorder': {
          const repository = getRepository();
          return {
            success: true,
            data: { reordered: repository.reorder(payload.sessionId, payload.orderedIds) },
          } satisfies IPCResponse;
        }

        case 'sendNow': {
          const repository = getRepository();
          const record = repository.getById(payload.id);
          if (!record || !deps.sendNow) {
            return invalidState(`Queued input cannot be sent now: ${payload.id}`);
          }
          const isDelegation = deps.delegation?.isDelegationRow(payload.id) === true;
          // INV-1：用户 sendNow 与自动 drain 同一条规矩——先复核再抢占。
          // 委托行经守卫复核；普通用户行保持现行为。
          let delegationOrigin: DelegationOriginMarker | undefined;
          if (isDelegation && deps.delegation) {
            const decision = await deps.delegation.beforeSendNowClaim(record);
            if (decision.kind === 'wait') {
              return {
                success: true,
                data: { status: 'queued' as const, retryCount: record.retryCount },
              } satisfies IPCResponse;
            }
            if (decision.kind === 'pause') {
              repository.pauseQueued(payload.id, decision.code);
              return invalidState(`Delegation delivery recheck paused (${decision.code}): ${payload.id}`);
            }
            delegationOrigin = decision.delegationOrigin;
          }
          const route = deps.hasActiveRun?.(record.sessionId) ? 'active' : 'idle';
          // 委托行不得经 steer（活跃分支）投递：steer 会绕过 run 身份与回填义务。
          if (isDelegation && route === 'active') {
            return invalidState(`Delegation cannot be delivered by steer: ${payload.id}`);
          }
          const claimed = record.status === 'queued'
            ? repository.markSending(payload.id)
            : repository.markSendingForRetry(payload.id);
          if (!claimed) {
            return invalidState(`Queued input is not ready to send: ${payload.id}`);
          }

          let delivery: 'sent' | 'steered' | 'queued';
          try {
            delivery = await deps.sendNow({
              id: record.id,
              sessionId: record.sessionId,
              envelope: JSON.parse(record.envelopeJson) as ConversationEnvelope,
              ...(delegationOrigin ? { delegationOrigin } : {}),
            }, route);
          } catch {
            return reportSendOutcome(repository, payload.id, 'failure');
          }

          if (delivery === 'queued') {
            const queued = repository.getById(payload.id);
            if (queued?.status !== 'queued') {
              return invalidState(`Queued input was not restored after redirect: ${payload.id}`);
            }
            return {
              success: true,
              data: { status: 'queued' as const, retryCount: queued.retryCount },
            } satisfies IPCResponse;
          }
          return reportSendOutcome(repository, payload.id, 'success');
        }

        case 'retract': {
          const repository = getRepository();
          const retracted = repository.retract(payload.id);
          if (retracted && deps.delegation?.isDelegationRow(payload.id)) {
            const record = repository.getById(payload.id);
            if (record) {
              deps.delegation.onRetracted(record);
            }
          }
          return {
            success: true,
            data: { retracted },
          } satisfies IPCResponse;
        }

        case 'markSending': {
          const repository = getRepository();
          if (deps.delegation?.isDelegationRow(payload.id)) {
            return invalidState(`Delegation cannot be claimed by raw markSending: ${payload.id}`);
          }
          return {
            success: true,
            data: { marked: repository.markSending(payload.id) },
          } satisfies IPCResponse;
        }

        case 'reportSendOutcome': {
          const repository = getRepository();
          if (deps.delegation?.isDelegationRow(payload.id)) {
            return invalidState(`Delegation outcome is managed by the host drain: ${payload.id}`);
          }
          return reportSendOutcome(repository, payload.id, payload.outcome);
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown queued input action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Queued input IPC error:', error);
      return {
        success: false,
        error: {
          code: 'QUEUED_INPUT_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      } satisfies IPCResponse;
    }
  }, ipcMain);
}
