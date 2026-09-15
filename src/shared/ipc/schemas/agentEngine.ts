// ============================================================================
// AgentEngine Domain Schemas - agentEngine 域 action 集合真源（RQ-183 续作·AGENT_ENGINE 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron/loop 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 agentEngine 域、handler 表（src/host/ipc/agentEngine.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const AgentEngineDomainRequestSchema = z.object({
  action: z.enum([
    'detect',
    'get',
    'list',
    'listHistory',
    'listModels',
    'listSources',
    'previewHistory',
    'select',
    'selectModel',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type AgentEngineDomainRequest = z.infer<typeof AgentEngineDomainRequestSchema>;

export const AgentEngineSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.AGENT_ENGINE, payload: AgentEngineDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: AgentEngineDomainRequestSchema.shape.action.options,
} as const;
