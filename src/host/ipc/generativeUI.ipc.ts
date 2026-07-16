import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type {
  NeoUIApplyEventRequest,
  NeoUIResolveInstanceRequest,
  NeoUIResolveManifestRequest,
} from '../../shared/contract/generativeUI';
import { getGenerativeUIService } from '../services/generativeUI/generativeUIService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('GenerativeUIIPC');

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}

export function registerGenerativeUIHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.GENERATIVE_UI, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const service = getGenerativeUIService();
    try {
      switch (request.action) {
        case 'capabilities':
          return {
            success: true,
            data: {
              nativeGenerativeUI: service.isEnabled(),
              executionManifestV1: service.isManifestEnabled(),
            },
          };
        case 'resolveInstance': {
          const payload = request.payload as NeoUIResolveInstanceRequest | undefined;
          if (!payload?.sessionId || !payload.sourceMessageId || !Number.isInteger(payload.sourceOrdinal) || typeof payload.rawSpec !== 'string') {
            return invalid('sessionId, sourceMessageId, sourceOrdinal and rawSpec are required');
          }
          return { success: true, data: service.resolveInstance(payload) };
        }
        case 'applyEvent': {
          const payload = request.payload as NeoUIApplyEventRequest | undefined;
          if (!payload?.event?.eventId || !payload.event.sessionId || !payload.event.instanceId) {
            return invalid('event identity is required');
          }
          return { success: true, data: service.applyEvent(payload.event) };
        }
        case 'resolveManifest': {
          const payload = request.payload as NeoUIResolveManifestRequest | undefined;
          if (!payload?.sessionId || !payload.manifestId || !payload.nonce) {
            return invalid('sessionId, manifestId and nonce are required');
          }
          if (payload.decision !== 'approve' && payload.decision !== 'reject') {
            return invalid('decision must be approve or reject');
          }
          return { success: true, data: service.resolveManifest(payload) };
        }
        default:
          return { success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${request.action}` } };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Generative UI domain action failed', { action: request.action, message });
      return { success: false, error: { code: 'GENERATIVE_UI_ERROR', message } };
    }
  });
}
