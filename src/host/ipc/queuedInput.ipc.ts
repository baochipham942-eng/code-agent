import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import { QueuedInputSchemas } from '../../shared/ipc/schemas';
import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
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

export function registerQueuedInputHandlers(ipcMain: IpcMain): void {
  defineHandler(QueuedInputSchemas.REQUEST, async (_event, request) => {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'enqueue': {
          const repository = getRepository();
          const envelopeJson = JSON.stringify(payload.envelope);
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
          if (payload.outcome === 'success') {
            if (!repository.markConsumed(payload.id)) {
              return invalidState(`Queued input is not sending: ${payload.id}`);
            }
            const consumed = repository.getById(payload.id);
            if (!consumed) {
              return invalidState(`Queued input disappeared after send success: ${payload.id}`);
            }
            return {
              success: true,
              data: { status: 'consumed' as const, retryCount: consumed.retryCount },
            } satisfies IPCResponse;
          }

          const requeued = repository.requeueAfterFailure(payload.id);
          if (!requeued) {
            return invalidState(`Queued input is not sending: ${payload.id}`);
          }

          if (requeued.retryCount > QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS) {
            if (!repository.markFailed(payload.id)) {
              return invalidState(`Queued input could not transition to failed: ${payload.id}`);
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
