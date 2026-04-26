// ============================================================================
// OpenChronicle (屏幕记忆) IPC Handlers - openchronicle:* actions
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  loadSettings,
  saveSettings,
  setEnabled,
  getStatus,
} from '../services/external/openchronicleSupervisor';
import type { OpenchronicleSettings } from '../../shared/contract/openchronicle';

export function registerOpenchronicleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.OPENCHRONICLE, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;
    try {
      let data: unknown;
      switch (action) {
        case 'getSettings':
          data = await loadSettings();
          break;
        case 'updateSettings': {
          const next = request.payload as OpenchronicleSettings;
          await saveSettings(next);
          data = { success: true };
          break;
        }
        case 'setEnabled': {
          const { enabled } = request.payload as { enabled: boolean };
          data = await setEnabled(enabled);
          break;
        }
        case 'getStatus':
          data = await getStatus();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
}
