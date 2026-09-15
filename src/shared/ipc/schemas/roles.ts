// ============================================================================
// Roles Domain Schemas - roles 域 action 集合真源（RQ-183 续作·ROLES 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron/loop 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 roles 域、handler 表（src/host/ipc/roles.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const RolesDomainRequestSchema = z.object({
  action: z.enum([
    'addBinding',
    'confirmDraft',
    'deleteMemory',
    'detail',
    'list',
    'listBindings',
    'listBoundCronJobs',
    'listDrafts',
    'rejectDraft',
    'removeBinding',
    'restoreFactory',
    'rolePackInstall',
    'rolePackList',
    'rolePackRetryMissingSkills',
    'rolePackUninstall',
    'setProactivity',
    'updateDefinitionBody',
    'updateEquipment',
    'updateMemory',
    'updatePersonalization',
    'updateVisual',
    'writeProjectMemory',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type RolesDomainRequest = z.infer<typeof RolesDomainRequestSchema>;

export const RolesSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.ROLES, payload: RolesDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: RolesDomainRequestSchema.shape.action.options,
} as const;
