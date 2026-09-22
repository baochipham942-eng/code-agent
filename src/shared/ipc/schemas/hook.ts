// ============================================================================
// Hook Domain Schemas - hook 域 action 集合真源（RQ-183 续作·HOOK 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 hook 域、handler 表（src/host/ipc/hook.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const HookDomainRequestSchema = z.object({
  action: z.enum([
    'list',
    'openConfigFile',
    'revealConfigFolder',
    'setEnabled',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type HookDomainRequest = z.infer<typeof HookDomainRequestSchema>;

export const HookSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.HOOK, payload: HookDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: HookDomainRequestSchema.shape.action.options,
} as const;
