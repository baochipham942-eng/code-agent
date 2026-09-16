// ============================================================================
// Device Domain Schemas - device 域 action 集合真源（RQ-183 续作·SYNC+DEVICE 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 device 域、handler 表（src/host/ipc/sync.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const DeviceDomainRequestSchema = z.object({
  action: z.enum([
    'list',
    'register',
    'remove',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type DeviceDomainRequest = z.infer<typeof DeviceDomainRequestSchema>;

export const DeviceSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.DEVICE, payload: DeviceDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: DeviceDomainRequestSchema.shape.action.options,
} as const;
