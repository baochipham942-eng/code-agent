// ============================================================================
// Notification Domain Schemas - notification 域 action 集合真源（RQ-183 续作·NOTIFICATION 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 notification 域、handler 表（src/host/ipc/notification.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const NotificationDomainRequestSchema = z.object({
  action: z.enum([
    'getRecent',
    'reportClientDelivery',
    'reportPresence',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

/**
 * reportPresence 载荷（N-NOTIFY-PRESENCE-HEARTBEAT）：renderer 心跳上报桌面在场信号，
 * host 侧 DesktopPresence 落地后供 CompanionPushOutbox 抑制普通推送。host handler 用它
 * safeParse 拒绝畸形载荷；renderer hook 以同形类型组装，两端对称。
 */
export const notificationPresenceReportSchema = z.object({
  visible: z.boolean(),
  focused: z.boolean(),
  lastInputAt: z.number(),
  viewingSessionId: z.string().nullable().optional(),
}).strict();
export type NotificationPresenceReport = z.infer<typeof notificationPresenceReportSchema>;

export type NotificationDomainRequest = z.infer<typeof NotificationDomainRequestSchema>;

export const NotificationSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.NOTIFICATION, payload: NotificationDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: NotificationDomainRequestSchema.shape.action.options,
} as const;
