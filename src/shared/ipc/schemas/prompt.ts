// ============================================================================
// Prompt Domain Schemas - prompt 域 action 集合真源（RQ-183 续作·PROMPT 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron 域）：action 用 z.enum 钉死合法字面量，payload
// 保持 z.unknown。集合与 shellCapabilities 的 prompt 域、handler 表（src/host/ipc/prompt.ipc.ts）
// 三面由 tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const PromptDomainRequestSchema = z.object({
  action: z.enum([
    'debugSystemPrompt',
    'get',
    'list',
    'preview',
    'reset',
    'set',
    'stackSummary',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type PromptDomainRequest = z.infer<typeof PromptDomainRequestSchema>;

export const PromptSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.PROMPT, payload: PromptDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: PromptDomainRequestSchema.shape.action.options,
} as const;
