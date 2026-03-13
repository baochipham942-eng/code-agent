// ============================================================================
// Desktop IPC Handlers - 原生桌面活动查询
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '@shared/ipc';
import type { DesktopSearchQuery, DesktopTimelineQuery } from '@shared/types';
import { getNativeDesktopService } from '../services/nativeDesktopService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DesktopIPC');

export function registerDesktopHandlers(ipcMain: IpcMain): void {
  const service = getNativeDesktopService();

  ipcMain.handle(IPC_DOMAINS.DESKTOP, async (_event, request: IPCRequest) => {
    try {
      switch (request.action) {
        case 'getStatus':
          return { success: true, data: service.getStatus() } satisfies IPCResponse<unknown>;

        case 'getCurrentContext':
          return { success: true, data: service.getCurrentContext() } satisfies IPCResponse<unknown>;

        case 'listRecent': {
          const payload = request.payload as { limit?: number } | undefined;
          return { success: true, data: service.listRecent(payload?.limit || 10) } satisfies IPCResponse<unknown>;
        }

        case 'getTimeline': {
          const payload = (request.payload || {}) as DesktopTimelineQuery;
          return { success: true, data: service.getTimeline(payload) } satisfies IPCResponse<unknown>;
        }

        case 'search': {
          const payload = request.payload as DesktopSearchQuery;
          return { success: true, data: service.search(payload) } satisfies IPCResponse<unknown>;
        }

        case 'getStats': {
          const payload = (request.payload || {}) as DesktopTimelineQuery;
          return { success: true, data: service.getStats(payload) } satisfies IPCResponse<unknown>;
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${request.action}` },
          } satisfies IPCResponse<unknown>;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Desktop IPC error', { action: request.action, error: message });
      return {
        success: false,
        error: { code: 'DESKTOP_ERROR', message },
      } satisfies IPCResponse<unknown>;
    }
  });

  logger.info('Desktop handlers registered');
}
