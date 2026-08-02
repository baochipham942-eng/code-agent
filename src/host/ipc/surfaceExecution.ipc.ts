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
  SurfaceLiveStreamRequestV1,
  SurfaceLiveStreamStateV1,
  SurfaceOutputPayloadV1,
  SurfaceOutputRequestV1,
  SurfaceSessionControlActionV1,
  SurfaceSessionControlRequestV1,
  SurfaceSessionControlResultV1,
  SurfaceTerminalFrameGetRequestV1,
  SurfaceTerminalFrameGetResultV1,
  SurfaceTerminalFramePersistRequestV1,
  SurfaceTerminalFramePersistResultV1,
  SurfaceTerminalFramesDeleteRequestV1,
  SurfaceTerminalFramesDeleteResultV1,
} from '../../shared/contract/surfaceExecution';
import { createLogger } from '../services/infra/logger';
import {
  getSurfaceConversationProjectionService,
  type SurfaceConversationProjectionService,
} from '../services/surfaceExecution/SurfaceConversationProjectionService';
import { SurfaceExecutionRuntimeError } from '../services/surfaceExecution/SurfaceExecutionRuntimeError';
import {
  getSurfaceLiveStreamService,
  type SurfaceLiveStreamService,
} from '../services/surfaceExecution/SurfaceLiveStreamService';
import {
  deleteTerminalFramesForConversation,
  persistTerminalFrame,
  readTerminalFrame,
} from '../services/surfaceExecution/TerminalFrameStore';

const logger = createLogger('SurfaceExecutionIPC');

type SurfaceExecutionProjectionApi = Pick<
  SurfaceConversationProjectionService,
  'getSnapshot' | 'getFrame' | 'getOutput' | 'control'
>;

type SurfaceLiveStreamApi = Pick<SurfaceLiveStreamService, 'start' | 'stop'>;

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
const LIVE_STREAM_KEYS = new Set([
  'version',
  'conversationId',
  'surfaceSessionId',
  'maxWidth',
  'maxHeight',
]);
const CONTROL_KEYS = new Set([
  'version',
  'conversationId',
  'surfaceSessionId',
  'action',
  'reason',
]);
const TERMINAL_FRAME_PERSIST_KEYS = new Set([
  'version',
  'conversationId',
  'surfaceSessionId',
  'dataUrl',
]);
const TERMINAL_FRAME_GET_KEYS = new Set(['version', 'conversationId', 'surfaceSessionId']);
const TERMINAL_FRAMES_DELETE_KEYS = new Set(['version', 'conversationId']);

/** 终态留影 decoded bytes 硬上限：1MB。超了拒收（renderer 侧已先降采样到 384KB 软目标） */
const TERMINAL_FRAME_MAX_BYTES = 1024 * 1024;
const TERMINAL_FRAME_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

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

function parseLiveStreamPayload(value: unknown): SurfaceLiveStreamRequestV1 | null {
  const optionalBound = (bound: unknown): boolean => (
    bound === undefined || (Number.isSafeInteger(bound) && Number(bound) > 0)
  );
  if (!isRecord(value)
    || !hasOnlyKeys(value, LIVE_STREAM_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId)
    || !nonEmptyString(value.surfaceSessionId)
    || !optionalBound(value.maxWidth)
    || !optionalBound(value.maxHeight)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
    surfaceSessionId: value.surfaceSessionId.trim(),
    ...(typeof value.maxWidth === 'number' ? { maxWidth: value.maxWidth } : {}),
    ...(typeof value.maxHeight === 'number' ? { maxHeight: value.maxHeight } : {}),
  };
}

function parseTerminalFramePersistPayload(
  value: unknown,
): SurfaceTerminalFramePersistRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, TERMINAL_FRAME_PERSIST_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId, 256)
    || !nonEmptyString(value.surfaceSessionId, 256)
    || typeof value.dataUrl !== 'string'
    || !value.dataUrl.startsWith(TERMINAL_FRAME_DATA_URL_PREFIX)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
    surfaceSessionId: value.surfaceSessionId.trim(),
    dataUrl: value.dataUrl,
  };
}

function parseTerminalFrameGetPayload(
  value: unknown,
): SurfaceTerminalFrameGetRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, TERMINAL_FRAME_GET_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId, 256)
    || !nonEmptyString(value.surfaceSessionId, 256)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
    surfaceSessionId: value.surfaceSessionId.trim(),
  };
}

function parseTerminalFramesDeletePayload(
  value: unknown,
): SurfaceTerminalFramesDeleteRequestV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, TERMINAL_FRAMES_DELETE_KEYS)
    || value.version !== 1
    || !nonEmptyString(value.conversationId, 256)) {
    return null;
  }
  return {
    version: 1,
    conversationId: value.conversationId.trim(),
  };
}

async function requireTerminalFrameScope(
  service: SurfaceExecutionProjectionApi,
  selector: SurfaceTerminalFrameGetRequestV1,
): Promise<void> {
  const snapshot = await service.getSnapshot(selector.conversationId);
  const projection = snapshot.sessions.find((candidate) => (
    candidate.session.sessionId === selector.surfaceSessionId
    && candidate.session.surface === 'browser'
  ));
  if (projection) return;
  throw new SurfaceExecutionRuntimeError({
    code: 'SURFACE_TARGET_NOT_OWNED',
    message: 'Terminal Surface frame is unavailable for this conversation session.',
    phase: 'artifact',
    recommendedAction: 'Refresh the Surface conversation before requesting the terminal frame.',
    surface: 'browser',
    provider: 'surface-terminal-frame',
    sessionId: selector.surfaceSessionId,
  });
}

async function handleTerminalFramePersist(
  payload: SurfaceTerminalFramePersistRequestV1,
): Promise<SurfaceTerminalFramePersistResultV1> {
  const encoded = payload.dataUrl.slice(TERMINAL_FRAME_DATA_URL_PREFIX.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { version: 1, ok: false, reason: 'invalid base64 frame payload' };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) {
    return { version: 1, ok: false, reason: 'empty frame payload' };
  }
  if (bytes.length > TERMINAL_FRAME_MAX_BYTES) {
    logger.warn('Terminal frame rejected: over size limit', {
      conversationId: payload.conversationId,
      surfaceSessionId: payload.surfaceSessionId,
      bytes: bytes.length,
    });
    return { version: 1, ok: false, reason: `frame exceeds ${TERMINAL_FRAME_MAX_BYTES} bytes` };
  }
  try {
    await persistTerminalFrame(payload, bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Terminal frame rejected: not a JPEG', {
      conversationId: payload.conversationId,
      surfaceSessionId: payload.surfaceSessionId,
      message: reason,
    });
    return { version: 1, ok: false, reason };
  }
  return { version: 1, ok: true, bytes: bytes.length };
}

async function handleTerminalFrameGet(
  payload: SurfaceTerminalFrameGetRequestV1,
): Promise<SurfaceTerminalFrameGetResultV1> {
  const bytes = await readTerminalFrame(payload);
  if (!bytes) return { version: 1, frame: null };
  return {
    version: 1,
    frame: {
      dataUrl: `${TERMINAL_FRAME_DATA_URL_PREFIX}${bytes.toString('base64')}`,
      bytes: bytes.length,
    },
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
  getLiveStream: () => SurfaceLiveStreamApi = getSurfaceLiveStreamService,
): void {
  ipcMain.handle(
    IPC_DOMAINS.SURFACE_EXECUTION,
    async (_event, request: IPCRequest): Promise<IPCResponse<
      SurfaceConversationSnapshotV1 | SurfaceFramePayloadV1 | SurfaceOutputPayloadV1
      | SurfaceSessionControlResultV1 | SurfaceLiveStreamStateV1
      | SurfaceTerminalFramePersistResultV1 | SurfaceTerminalFrameGetResultV1
      | SurfaceTerminalFramesDeleteResultV1
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
        if (request?.action === 'startLiveStream' || request?.action === 'stopLiveStream') {
          const payload = parseLiveStreamPayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation and Surface session are required.');
          }
          return {
            success: true,
            data: request.action === 'startLiveStream'
              ? await getLiveStream().start(payload)
              : await getLiveStream().stop(payload.surfaceSessionId),
          };
        }
        if (request?.action === 'persistTerminalFrame') {
          const payload = parseTerminalFramePersistPayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation, Surface session, and JPEG dataUrl are required.');
          }
          await requireTerminalFrameScope(getService(), payload);
          return {
            success: true,
            data: await handleTerminalFramePersist(payload),
          };
        }
        if (request?.action === 'getPersistedTerminalFrame') {
          const payload = parseTerminalFrameGetPayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation and Surface session are required.');
          }
          await requireTerminalFrameScope(getService(), payload);
          return {
            success: true,
            data: await handleTerminalFrameGet(payload),
          };
        }
        if (request?.action === 'deletePersistedTerminalFrames') {
          const payload = parseTerminalFramesDeletePayload(request.payload);
          if (!payload) {
            return invalid('A scoped conversation is required.');
          }
          // getSnapshot 是 owner gate；删除整段会话留影不接受 renderer 自报 authority。
          await getService().getSnapshot(payload.conversationId);
          await deleteTerminalFramesForConversation(payload.conversationId);
          return {
            success: true,
            data: { version: 1, deleted: true },
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
