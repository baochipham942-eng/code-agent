// ============================================================================
// Admin IPC Handlers - user dashboard + invite code management
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type {
  AdminCreateInviteCodeInput,
  AdminUpdateInviteCodeInput,
} from '../../shared/contract';
import { getAdminService } from '../services/admin';
import { getAdminAccessIpcError } from './adminGuard';

export function registerAdminHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.ADMIN, async (_, request: IPCRequest): Promise<IPCResponse> => {
    try {
      const accessError = getAdminAccessIpcError('Admin');
      if (accessError) return accessError;

      let data: unknown;

      switch (request.action) {
        case 'listUsers':
          data = await getAdminService().listUsers();
          break;
        case 'listInviteCodes':
          data = await getAdminService().listInviteCodes();
          break;
        case 'createInviteCode':
          data = await getAdminService().createInviteCode(
            request.payload as AdminCreateInviteCodeInput,
          );
          break;
        case 'updateInviteCode':
          data = await getAdminService().updateInviteCode(
            request.payload as AdminUpdateInviteCodeInput,
          );
          break;
        default:
          return {
            success: false,
            error: {
              code: 'INVALID_ACTION',
              message: `Unknown action: ${request.action}`,
            },
          };
      }

      return { success: true, data };
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
