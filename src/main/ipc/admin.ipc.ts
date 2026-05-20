// ============================================================================
// Admin IPC Handlers - user dashboard + invite code management
// ============================================================================

import type { IpcMain } from '../platform';
import { AdminSchemas, type ResponseOf } from '../../shared/ipc/schemas';
import { defineHandler } from '../platform/ipcRegistry';
import { getAdminService } from '../services/admin';
import { getAdminAccessIpcError } from './adminGuard';

type AdminResponse = ResponseOf<typeof AdminSchemas.REQUEST>;

function toAdminErrorResponse(error: NonNullable<ReturnType<typeof getAdminAccessIpcError>>): AdminResponse {
  return {
    success: false,
    error: error.error || {
      code: 'FORBIDDEN',
      message: 'Admin permission required',
    },
  };
}

export function registerAdminHandlers(ipcMain: IpcMain): void {
  defineHandler(AdminSchemas.REQUEST, async (_, request): Promise<AdminResponse> => {
    try {
      const accessError = getAdminAccessIpcError('Admin');
      if (accessError) return toAdminErrorResponse(accessError);

      const adminService = getAdminService();

      switch (request.action) {
        case 'listUsers':
          return { success: true, data: await adminService.listUsers() };
        case 'listInviteCodes':
          return { success: true, data: await adminService.listInviteCodes() };
        case 'createInviteCode':
          return { success: true, data: await adminService.createInviteCode(request.payload) };
        case 'updateInviteCode':
          return { success: true, data: await adminService.updateInviteCode(request.payload) };
        case 'listControlPlaneAuditEvents':
          return {
            success: true,
            data: await adminService.listControlPlaneAuditEvents(request.payload?.limit),
          };
        case 'listControlPlaneRolloutSummary':
          return { success: true, data: await adminService.listControlPlaneRolloutSummary() };
      }

      const _exhaustive: never = request;
      return {
        success: false,
        error: {
          code: 'INVALID_ACTION',
          message: `Unknown action: ${String(_exhaustive)}`,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }, ipcMain);
}
