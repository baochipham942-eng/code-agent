// ============================================================================
// Project Domain Schemas - project 域 action 集合真源（RQ-183 续作·PROJECT 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron/loop/sync/window 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 project 域、handler 表（src/host/ipc/project.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const ProjectDomainRequestSchema = z.object({
  action: z.enum([
    'addGoal',
    'addRole',
    'addSource',
    'artifactIssues',
    'artifacts',
    'create',
    'createInvite',
    'createSpace',
    'deleteProject',
    'detail',
    'gitStates',
    'list',
    'listCapabilitySelections',
    'listCloudCards',
    'listMembers',
    'listWithActivity',
    'promoteToCloudSpace',
    'promoteToSpace',
    'redeemInvite',
    'removeRole',
    'removeSource',
    'rename',
    'resyncCloudCards',
    'revokeInvite',
    'selectCapability',
    'setDescription',
    'setPrimarySource',
    'setStatus',
    'sources',
    'unselectCapability',
    'updateGoalStatus',
    'updateProject',
    'updateSourceAccess',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type ProjectDomainRequest = z.infer<typeof ProjectDomainRequestSchema>;

export const ProjectSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.PROJECT, payload: ProjectDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: ProjectDomainRequestSchema.shape.action.options,
} as const;
