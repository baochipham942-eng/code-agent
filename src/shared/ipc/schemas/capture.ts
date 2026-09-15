// ============================================================================
// Capture Domain Schemas - capture 域 action 集合真源（RQ-183 续作·CAPTURE 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron/loop 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 capture 域、handler 表（src/host/ipc/capture.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const CaptureDomainRequestSchema = z.object({
  action: z.enum([
    'capture',
    'delete',
    'get',
    'importFiles',
    'list',
    'search',
    'selectFiles',
    'stats',
    'wechatStatus',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type CaptureDomainRequest = z.infer<typeof CaptureDomainRequestSchema>;

export const CaptureSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.CAPTURE, payload: CaptureDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: CaptureDomainRequestSchema.shape.action.options,
} as const;
