import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import { QueuedInputSchemas } from '../../shared/ipc/schemas';
import type {
  ConversationEnvelope,
  ConversationModelSpec,
} from '../../shared/contract/conversationEnvelope';
import type { QueuedInput } from '../../shared/contract/queuedInput';
import { QUEUED_INPUT_RETRY } from '../../shared/constants/queuedInput';
import { defineHandler } from '../platform/ipcRegistry';
import { getDatabase } from '../services/core/databaseService';
import {
  QueuedInputRepository,
  type QueuedInputRecord,
} from '../services/core/repositories/QueuedInputRepository';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('QueuedInputIPC');

function getRepository(): QueuedInputRepository {
  const db = getDatabase().getDb();
  if (!db) {
    throw new Error('Database is not initialized');
  }
  return new QueuedInputRepository(db);
}

function toQueuedInput(record: QueuedInputRecord): QueuedInput {
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
  }, route: 'active' | 'idle') => Promise<'sent' | 'steered' | 'queued'>;
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
            data: records.map(toQueuedInput),
          } satisfies IPCResponse;
        }

        case 'update': {
          const repository = getRepository();
          const record = repository.getById(payload.id);
          if (record?.status !== 'queued') {
            return invalidState(`Queued input is not editable: ${payload.id}`);
          }
          const envelope = JSON.parse(record.envelopeJson) as ConversationEnvelope;
          const updated = repository.updateEnvelope(
            payload.id,
            JSON.stringify({ ...envelope, content: payload.content }),
          );
          return { success: true, data: { updated } } satisfies IPCResponse;
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
            }, deps.hasActiveRun?.(record.sessionId) ? 'active' : 'idle');
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
          return {
            success: true,
            data: { retracted: repository.retract(payload.id) },
          } satisfies IPCResponse;
        }

        case 'markSending': {
          const repository = getRepository();
          return {
            success: true,
            data: { marked: repository.markSending(payload.id) },
          } satisfies IPCResponse;
        }

        case 'reportSendOutcome': {
          const repository = getRepository();
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
