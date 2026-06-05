// ============================================================================
// Notification IPC Handlers — 桌面通知只读查询
//
// 仅暴露「最近通知」读取，用于核验后台 loop / 定时任务完成时确有发出完成提醒
// （dry-run 模式下 notificationService 也会记录，E2E 据此断言）。不提供写操作。
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { notificationService } from '../services/infra/notificationService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('NotificationIPC');

export function registerNotificationHandlers(): void {
  ipcMain.handle(IPC_DOMAINS.NOTIFICATION, async (_event, request: IPCRequest) => {
    const { action } = request;
    try {
      switch (action) {
        case 'getRecent':
          return { success: true, data: notificationService.getRecentNotifications() } satisfies IPCResponse;

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown notification action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Notification IPC error:', error);
      return {
        success: false,
        error: {
          code: 'NOTIFICATION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      } satisfies IPCResponse;
    }
  });
}
