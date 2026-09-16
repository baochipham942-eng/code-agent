// ============================================================================
// Auth Domain Schemas - auth 域 action 集合真源（RQ-183 续作·AUTH 刀）
// ============================================================================
//
// 最小表形态（方案 2.1/2.5）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 auth 域、handler 表（src/host/ipc/auth.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const AuthDomainRequestSchema = z.object({
  action: z.enum([
    'clearSavedCredentials',
    'generateQuickToken',
    'getSavedCredentials',
    'getStatus',
    'getUser',
    'passwordResetCallback',
    'resetPassword',
    'saveCredentials',
    'signInEmail',
    'signInOAuth',
    'signInToken',
    'signOut',
    'signUpEmail',
    'updatePassword',
    'updateProfile',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type AuthDomainRequest = z.infer<typeof AuthDomainRequestSchema>;

export const AuthSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.AUTH, payload: AuthDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: AuthDomainRequestSchema.shape.action.options,
} as const;
