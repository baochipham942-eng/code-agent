// ============================================================================
// Tag Domain Schemas - tag 域 action 集合真源（RQ-183 续作·TAG 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 tag 域、handler 表（src/host/ipc/tag.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const TagDomainRequestSchema = z.object({
  action: z.enum([
    'acceptResult',
    'appendDelta',
    'approve',
    'approveMemoryCandidate',
    'approveRevision',
    'archive',
    'cancel',
    'continueAndRun',
    'createAndRun',
    'createDraft',
    'get',
    'list',
    'listAll',
    'listByProject',
    'listBySourceConversation',
    'read',
    'reject',
    'rejectMemoryCandidate',
    'rejectRevision',
    'requestChanges',
    'updateDraftRevision',
    'updateMeta',
    'updateRevision',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type TagDomainRequest = z.infer<typeof TagDomainRequestSchema>;

export const TagSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.TAG, payload: TagDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: TagDomainRequestSchema.shape.action.options,
} as const;
