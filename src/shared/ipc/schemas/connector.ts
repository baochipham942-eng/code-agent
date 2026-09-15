// ============================================================================
// Connector Domain Schemas - connector 域 action 集合真源（RQ-183 续作·CONNECTOR 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron/loop 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 connector 域、handler 表（src/host/ipc/connector.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const ConnectorDomainRequestSchema = z.object({
  action: z.enum([
    'disconnect',
    'listNativeInventory',
    'listStatuses',
    'oauthCancelConnect',
    'oauthConnect',
    'oauthDisconnect',
    'oauthSaveDescriptor',
    'oauthSetSecret',
    'oauthStatus',
    'openApp',
    'probe',
    'remove',
    'repairPermission',
    'retry',
    'setNativeEnabled',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type ConnectorDomainRequest = z.infer<typeof ConnectorDomainRequestSchema>;

export const ConnectorSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.CONNECTOR, payload: ConnectorDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: ConnectorDomainRequestSchema.shape.action.options,
} as const;
