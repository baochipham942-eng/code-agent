// ============================================================================
// PermissionTranslate Domain Schemas — 一句话权限规则翻译域 action 集合真源
// ============================================================================
//
// 最小表形态（cron 域同款）：action 用 z.enum 钉死合法字面量，payload 保持 z.unknown。
// 集合与 shellCapabilities 的本域清单、handler 表（src/host/ipc/permissionTranslate.ipc.ts）
// 三面由 tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const PermissionTranslateDomainRequestSchema = z.object({
  action: z.enum(['translate']),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type PermissionTranslateDomainRequest = z.infer<typeof PermissionTranslateDomainRequestSchema>;

export const PermissionTranslateSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.PERMISSION_TRANSLATE, payload: PermissionTranslateDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: PermissionTranslateDomainRequestSchema.shape.action.options,
} as const;
