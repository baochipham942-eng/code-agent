// ============================================================================
// In-App Validation IPC Handlers
// ----------------------------------------------------------------------------
// 注册 renderer → main 的结果回传通道。
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { InAppValidationResultPayload } from '../../shared/contract/browserInteraction';
import { handleInAppValidationResult } from '../services/inAppValidationService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('InAppValidationIPC');

export function registerInAppValidationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.IN_APP_VALIDATION_RESULT,
    async (_event: unknown, payload: InAppValidationResultPayload) => {
      if (!payload || typeof payload.requestId !== 'string') {
        logger.warn('Received malformed in-app validation result payload', { payload });
        return;
      }
      handleInAppValidationResult(payload);
    },
  );
}
