import type { IpcMain } from '../platform';
import {
  IPC_DOMAINS,
  type IPCRequest,
  type IPCResponse,
} from '../../shared/ipc';
import type {
  SurfaceConversationSnapshotRequestV1,
  SurfaceConversationSnapshotV1,
  SurfaceFramePayloadV1,
  SurfaceFrameRequestV1,
  SurfaceOutputPayloadV1,
  SurfaceOutputRequestV1,
  SurfaceSessionControlActionV1,
  SurfaceSessionControlRequestV1,
  SurfaceSessionControlResultV1,
} from '../../shared/contract/surfaceExecution';
import { createLogger } from '../services/infra/logger';
import {
  getSurfaceConversationProjectionService,
  type SurfaceConversationProjectionService,
} from '../services/surfaceExecution/SurfaceConversationProjectionService';
import { SurfaceExecutionRuntimeError } from '../services/surfaceExecution/SurfaceExecutionRuntimeError';

const logger = createLogger('SurfaceExecutionIPC');

type SurfaceExecutionProjectionApi = Pick<
  SurfaceConversationProjectionService,
  'getSnapshot' | 'getFrame' | 'getOutput' | 'control'
>;

const CONTROL_ACTIONS: readonly SurfaceSessionControlActionV1[] = [
  'pause',
  'resume',
  'continue',
  'takeover',
  'stop',
  'end_session',
];

const SNAPSHOT_KEYS = new Set(['version', 'conversationId']);
const FRAME_KEYS = new Set(['version', 'conversationId', 'surfaceSessionId', 'assetRef']);
const OUTPUT_KEYS = new Set(['version', 'conversationId', 'surfaceSessionId', 'outputRef']);
const CONTROL_KEYS = new Set([
  'version',
  'conversationId',
  'surfaceSessionId',
  'action',
  'reason',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength;
}

function parseSnapshotPayload(value: unknown): SurfaceConversationSnapshotRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, SNAPSHOT_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
  };
}

function parseControlPayload(value: unknown): SurfaceSessionControlRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, CONTROL_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId)
    || !nonEmptyString(value.surfaceSessionId)
    || typeof value.action !== 'string'
    || !CONTROL_ACTIONS.includes(value.action as SurfaceSessionControlActionV1)
    || (value.reason !== undefined && !nonEmptyString(value.reason, 500))) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
    surfaceSessionId: value.surfaceSessionId.trim(),
    action: value.action as SurfaceSessionControlActionV1,
    ...(typeof value.reason === 'string' ? { reason: value.reason.trim() } : {}),
  };
}

function parseFramePayload(value: unknown): SurfaceFrameRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, FRAME_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId)
    || !nonEmptyString(value.surfaceSessionId)
    || !nonEmptyString(value.assetRef)
    || !/^surface-frame:\/\/[a-zA-Z0-9._:-]+$/.test(value.assetRef)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
    surfaceSessionId: value.surfaceSessionId.trim(),
    assetRef: value.assetRef.trim(),
  };
}

function parseOutputPayload(value: unknown): SurfaceOutputRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, OUTPUT_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId)
    || !nonEmptyString(value.surfaceSessionId)
    || !nonEmptyString(value.outputRef)
    || !/^surface-output:\/\/[a-zA-Z0-9._:-]+$/.test(value.outputRef)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
    surfaceSessionId: value.surfaceSessionId.trim(),
    outputRef: value.outputRef.trim(),
  };
}

function invalid<T = never>(message: string): IPCResponse<T> {
  return {
    success: false,
    error: { code: 'INVALID_ARGS', message },
  };
}

function surfaceFailure<T = never>(error: SurfaceExecutionRuntimeError): IPCResponse<T> {
  const surfaceError = error.surfaceError;
  return {
    success: false,
    error: {
      code: surfaceError.code,
      message: surfaceError.message,
      details: {
        retryable: surfaceError.retryable,
        userActionRequired: surfaceError.userActionRequired,
        recommendedAction: surfaceError.recommendedAction,
      },
    },
  };
}

export function registerSurfaceExecutionHandlers(
  ipcMain: IpcMain,
  getService: () => SurfaceExecutionProjectionApi = getSurfaceConversationProjectionService,
): void {
  ipcMain.handle(
    IPC_DOMAINS.SURFACE_EXECUTION,
    async (_event, request: IPCRequest): Promise<IPCResponse<
      SurfaceConversationSnapshotV1 | SurfaceFramePayloadV1 | SurfaceOutputPayloadV1 | SurfaceSessionControlResultV1
    >> => {
      try {
        if (request?.action === 'getSnapshot') {
          const payload = parseSnapshotPayload(request.payload);
          if (!payload) {
            return invalid('version and conversationId are required; authority fields are not accepted.');
          }
          return {
            success: true,
            data: await getService().getSnapshot(payload.conversationId),
          };
        }
        if (request?.action === 'control') {
          const payload = parseControlPayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation, Surface session, and supported control action are required.');
          }
          return {
            success: true,
            data: await getService().control(payload),
          };
        }
        if (request?.action === 'getFrame') {
          const payload = parseFramePayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation, Surface session, and opaque frame ref are required.');
          }
          return {
            success: true,
            data: await getService().getFrame(payload),
          };
        }
        if (request?.action === 'getOutput') {
          const payload = parseOutputPayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation, Surface session, and opaque output ref are required.');
          }
          return {
            success: true,
            data: await getService().getOutput(payload),
          };
        }
        return {
          success: false,
          error: { code: 'UNKNOWN_ACTION', message: 'Unknown Surface Execution action.' },
        };
      } catch (error) {
        if (error instanceof SurfaceExecutionRuntimeError) return surfaceFailure(error);
        logger.warn('Surface Execution domain action failed', {
          action: request?.action,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: {
            code: 'SURFACE_EXECUTION_ERROR',
            message: 'Surface Execution request failed safely.',
          },
        };
      }
    },
  );
}
