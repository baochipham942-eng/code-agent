import { z } from 'zod';
import { COMPANION_LIMITS } from '../constants/companion';

const COMPANION_PUSH_TITLE_KEYS = {
  agent_complete: 'task_complete',
  agent_cancelled: 'task_stopped',
  error: 'task_failed',
  approval: 'approval_needed',
} as const;
/** 模型密钥用不了单独一句：它是用户能当场绕过去的失败，横幅里说成「电脑执行时出了问题」等于把原因藏起来（爸 2026-09-16 真机）。 */
const MODEL_AUTH_FAILED_TITLE_KEY = 'task_failed_model_auth';
const MODEL_UNAVAILABLE_TITLE_KEY = 'task_failed_model_unavailable';
/** 余额或额度用完同待遇（模拟器验收 O2）：用户能当场换模型绕过去，横幅不说通用失败句。 */
const MODEL_QUOTA_TITLE_KEY = 'task_failed_model_quota';
type CompanionPushKind = keyof typeof COMPANION_PUSH_TITLE_KEYS;
export type CompanionPushTitleKey = (typeof COMPANION_PUSH_TITLE_KEYS)[CompanionPushKind] | typeof MODEL_AUTH_FAILED_TITLE_KEY | typeof MODEL_UNAVAILABLE_TITLE_KEY | typeof MODEL_QUOTA_TITLE_KEY;

const companionPushProviderSchema = z.enum(['apns', 'fcm', 'vendor']);
const companionPushEnvironmentSchema = z.enum(['production', 'sandbox']);
export type CompanionPushProvider = z.infer<typeof companionPushProviderSchema>;
export type CompanionPushEnvironment = z.infer<typeof companionPushEnvironmentSchema>;

export const companionPushRegisterSchema = z.object({
  provider: companionPushProviderSchema,
  token: z.string().trim().min(8).max(4096),
  environment: companionPushEnvironmentSchema,
}).strict();
export type CompanionPushRegister = z.infer<typeof companionPushRegisterSchema>;

export const companionPushOpenSchema = z.object({
  routeToken: z.string().trim().min(16).max(COMPANION_LIMITS.idLength),
}).strict();

/** Wire payload: generalized title key, event kind, opaque route token. Nothing else. */
export interface GeneralizedPushPayload {
  titleKey: CompanionPushTitleKey;
  kind: CompanionPushKind;
  routeToken: string;
}

export type CompanionPushRegisterResult =
  | { kind: 'registered'; provider: CompanionPushProvider; environment: CompanionPushEnvironment }
  | { kind: 'rejected'; reason: 'device_revoked' | 'device_unknown' | 'invalid_command' | 'unsupported_action' };

export type CompanionPushUnregisterResult =
  | { kind: 'unregistered' }
  | { kind: 'rejected'; reason: 'device_revoked' | 'device_unknown' | 'unsupported_action' };

export type CompanionPushOpenResult =
  | { kind: 'open'; sessionId: string }
  | { kind: 'reread'; sessionId: string }
  | { kind: 'rejected'; reason: 'device_revoked' | 'device_unknown' | 'scope_denied' | 'unknown_token' | 'device_mismatch' };

type CompanionPushChannelMissing =
  | 'apns_auth_key'
  | 'aps_entitlement'
  | 'gms_or_vendor';

export type CompanionPushDispatchResult =
  | { accepted: true }
  | { accepted: false; code: 'CHANNEL_MISSING'; missing: CompanionPushChannelMissing }
  | { accepted: false; code: 'DEVICE_REVOKED' | 'SCOPE_DENIED' | 'NOT_REGISTERED' | 'EXPIRED' | 'TOKEN_UNWRAP_FAILED' }
  | { accepted: false; code: 'PROVIDER_RETRY'; retryAfterMs?: number };

export function companionPushTitleKey(kind: string, payload: Record<string, unknown>): CompanionPushTitleKey | null {
  if (kind === 'approval') return payload.status === 'pending' ? COMPANION_PUSH_TITLE_KEYS.approval : null;
  if (kind === 'error' && payload.code === 'MODEL_AUTH') return MODEL_AUTH_FAILED_TITLE_KEY;
  if (kind === 'error' && payload.code === 'MODEL_UNAVAILABLE') return MODEL_UNAVAILABLE_TITLE_KEY;
  if (kind === 'error' && payload.code === 'MODEL_QUOTA') return MODEL_QUOTA_TITLE_KEY;
  if (kind === 'agent_complete' || kind === 'agent_cancelled' || kind === 'error') return COMPANION_PUSH_TITLE_KEYS[kind];
  return null;
}
