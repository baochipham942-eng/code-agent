// ============================================================================
// Memory Domain Schemas - memory 域 action 集合真源（RQ-183 续作·MEMORY 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5，同 session 域）：action 用 z.enum 钉死合法字面量，payload
// 保持 z.unknown（表化迁移期行为严格不变，payload zod 细化是表立之后的增量）。集合与
// shellCapabilities 的 memory 域、handler 表（src/host/ipc/memory.ipc.ts memoryRoutes）
// 三面由 tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const MemoryDomainRequestSchema = z.object({
  action: z.enum([
    'delete',
    'deleteByCategory',
    'export',
    'getContext',
    'getMemoryStats',
    'getStats',
    'import',
    'lightDelete',
    'lightHealth',
    'lightList',
    'lightRead',
    'lightRebuildIndex',
    'lightStats',
    'list',
    'memoryAudit',
    'memoryEntries',
    'memoryEntryBatchReview',
    'memoryEntryDelete',
    'memoryEntryUpdate',
    'memoryExportV2',
    'memoryHarnessImportApply',
    'memoryHarnessImportConfirmDirective',
    'memoryHarnessImportDryRun',
    'memoryImportV2Apply',
    'memoryImportV2DryRun',
    'memoryInboxResolve',
    'memoryPack',
    'memoryRebuildMirror',
    'searchCode',
    'searchConversations',
    'update',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type MemoryDomainRequest = z.infer<typeof MemoryDomainRequestSchema>;

export const MemorySchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.MEMORY, payload: MemoryDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖，不必 import handler 表） */
  ACTIONS: MemoryDomainRequestSchema.shape.action.options,
} as const;
