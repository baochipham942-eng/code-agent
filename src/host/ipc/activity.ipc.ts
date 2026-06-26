import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '@shared/ipc';
import { getCurrentActivityContext } from '../services/activity/activityContextProvider';
import { listActivityProviders } from '../services/activity/activityProviderRegistry';

export function registerActivityHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.ACTIVITY, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    try {
      switch (request.action) {
        case 'listProviders':
          return { success: true, data: await listActivityProviders() };
        case 'getCurrentContext':
          return { success: true, data: await getCurrentActivityContext() };
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${request.action}` },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
