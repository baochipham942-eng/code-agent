// ============================================================================
// Session Domain Schemas - session 域 action 集合真源（RQ-183 刀 2）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死 46 个合法字面量，payload 保持
// z.unknown（表化迁移期行为严格不变，payload zod 细化是表立之后的增量）。集合与
// shellCapabilities 的 session 域、handler 表（src/host/ipc/domainRoutes/sessionRoutes.ts）
// 三面由 tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const SessionDomainRequestSchema = z.object({
  action: z.enum([
    'archive',
    'auditConversationLineage',
    'clearModelOverride',
    'compareConversationBranches',
    'create',
    'delete',
    'enqueueSessionForkSync',
    'export',
    'exportDiagnostics',
    'exportMarkdown',
    'exportSessionFork',
    'fork',
    'getForkLineage',
    'findExpertThread',
    'getMemoryContext',
    'getMessages',
    'getModelOverride',
    'getRecap',
    'getSessionTasks',
    'import',
    'importReadySessionForkSync',
    'importSessionFork',
    'ingestSessionForkSync',
    'list',
    'listConversationEvaluationAttributions',
    'listForkChildren',
    'load',
    'quarantineConversationLineage',
    'readSessionForkNeighborhood',
    'readSessionForkTree',
    'recordConversationEvaluationAttribution',
    'recoverHistory',
    'repairConversationLineage',
    'replayConversationBranch',
    'restoreConversationRewind',
    'restoreWorkspaceFilesAtCheckpoint',
    'rewindConversation',
    'rewindToPrompt',
    'search',
    'searchSessionForkExports',
    'traceConversationProvenance',
    'switchModel',
    'turnCheckout',
    'turnRedo',
    'unarchive',
    'update',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type SessionDomainRequest = z.infer<typeof SessionDomainRequestSchema>;

export const SessionSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.SESSION, payload: SessionDomainRequestSchema }),
} as const;
