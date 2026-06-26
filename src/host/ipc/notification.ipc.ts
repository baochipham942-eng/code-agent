// ============================================================================
// Notification IPC Handlers — 桌面通知只读查询
//
// 仅暴露「最近通知」读取，用于核验后台 loop / 定时任务完成时确有发出完成提醒
// （dry-run 模式下 notificationService 也会记录，E2E 据此断言）。不提供写操作。
// ============================================================================

import { ipcHost } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { notificationService } from '../services/infra/notificationService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('NotificationIPC');

export function registerNotificationHandlers(): void {
  ipcHost.handle(IPC_DOMAINS.NOTIFICATION, async (_event, request: IPCRequest) => {
    const { action, payload } = request;
    try {
      switch (action) {
        case 'getRecent':
          return { success: true, data: notificationService.getRecentNotifications() } satisfies IPCResponse;

        // 渲染端把原生通知投递结果回报主进程，落到日志便于诊断「没弹」问题
        case 'reportClientDelivery':
          logger.info('Client OS notification delivery', { report: payload });
          return { success: true, data: null } satisfies IPCResponse;

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
