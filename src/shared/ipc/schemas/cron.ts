// ============================================================================
// Cron Domain Schemas - cron 域 action 集合真源（RQ-183 续作·CRON 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 cron 域、handler 表（src/host/ipc/cron.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const CronDomainRequestSchema = z.object({
  action: z.enum([
    'createJob',
    'deleteJob',
    'generateFromPrompt',
    'getExecutions',
    'getRecentExecutions',
    'getStats',
    'listJobs',
    'triggerJob',
    'updateJob',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type CronDomainRequest = z.infer<typeof CronDomainRequestSchema>;

export const CronSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.CRON, payload: CronDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: CronDomainRequestSchema.shape.action.options,
} as const;
