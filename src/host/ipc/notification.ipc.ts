// ============================================================================
// Notification IPC Handlers — 桌面通知只读查询
//
// 仅暴露「最近通知」读取，用于核验后台 loop / 定时任务完成时确有发出完成提醒
// （dry-run 模式下 notificationService 也会记录，E2E 据此断言）。不提供写操作。
// ============================================================================

import { ipcHost } from '../platform';
import { NotificationSchemas, type NotificationDomainRequest } from '../../shared/ipc/schemas/notification';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { notificationService } from '../services/infra/notificationService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('NotificationIPC');

/**
 * notification 域单源路由表（RQ-183 续作·NOTIFICATION 刀）：原 domain switch 2 个 case 平移为默认模式 handler（返回 data，装配器包
 * { success: true, data }）：getRecent 回传最近通知，reportClientDelivery 记 info 日志后回 null。未知 action → UNKNOWN_ACTION +
 * `Unknown notification action:`（unknownActionCode / unknownActionMessage 保持原契约）；抛错进 mapError：原样记
 * `Notification IPC error:` 日志 + NOTIFICATION_ERROR（Error.message，非 Error 为 'Unknown error'）。
 * 请求体为 null / 非对象时原实现在 try 外解构抛错（IPC reject），现返回 UNKNOWN_ACTION。
 */
const notificationRoutes = defineDomainRoutes<NotificationDomainRequest, void>(NotificationSchemas.REQUEST, {
  getRecent: () => notificationService.getRecentNotifications(),
  // 渲染端把原生通知投递结果回报主进程，落到日志便于诊断「没弹」问题
  reportClientDelivery: (_ctx, payload) => {
    logger.info('Client OS notification delivery', { report: payload });
    return null;
  },
}, {
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown notification action: ${String(action)}`,
  mapError: (error) => {
    logger.error('Notification IPC error:', error);
    return { code: 'NOTIFICATION_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerNotificationHandlers(): void {
  installDomainRoutes(ipcHost, notificationRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerNotificationHandlers.routes = notificationRoutes;
