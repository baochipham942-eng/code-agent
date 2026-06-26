import type { IpcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { refreshAlmaRegistryAudit } from '../services/almaRegistry/almaRegistryAuditService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AlmaRegistryIPC');

export function registerAlmaRegistryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.ALMA_REGISTRY_AUDIT_REFRESH, async () => {
    try {
      const data = await refreshAlmaRegistryAudit();
      return { success: true, data };
    } catch (error) {
      logger.warn('Failed to refresh Alma registry audit', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
