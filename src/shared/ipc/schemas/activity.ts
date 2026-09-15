// ============================================================================
// Activity Domain Schemas - activity 域 action 集合真源（RQ-183 续作·ACTIVITY 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 activity 域、handler 表（src/host/ipc/activity.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const ActivityDomainRequestSchema = z.object({
  action: z.enum([
    'getCurrentContext',
    'listProviders',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type ActivityDomainRequest = z.infer<typeof ActivityDomainRequestSchema>;

export const ActivitySchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.ACTIVITY, payload: ActivityDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: ActivityDomainRequestSchema.shape.action.options,
} as const;
