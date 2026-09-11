import { z } from 'zod';
import { COMPANION_LIMITS } from '../constants/companion';

const COMPANION_PUSH_KINDS = ['agent_complete', 'agent_cancelled', 'error', 'approval'] as const;
type CompanionPushKind = (typeof COMPANION_PUSH_KINDS)[number];

const COMPANION_PUSH_TITLE_KEYS = {
  agent_complete: 'task_complete',
  agent_cancelled: 'task_stopped',
  error: 'task_failed',
  approval: 'approval_needed',
} as const;
export type CompanionPushTitleKey = (typeof COMPANION_PUSH_TITLE_KEYS)[CompanionPushKind];

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
  | { accepted: false; code: 'DEVICE_REVOKED' | 'SCOPE_DENIED' | 'NOT_REGISTERED' | 'EXPIRED' | 'TOKEN_UNWRAP_FAILED' };

export interface CompanionPushChannelGap {
  id: CompanionPushChannelMissing;
  present: false;
}

/** Inventory of this-round channel gaps. Android vendor/GMS is always missing. */
export function companionPushChannelGaps(input: {
  apsEnvironment: string | null;
  apnsKeyPath: string | null;
}): CompanionPushChannelGap[] {
  const gaps: CompanionPushChannelGap[] = [];
  if (!input.apnsKeyPath) gaps.push({ id: 'apns_auth_key', present: false });
  if (input.apsEnvironment !== 'production' && input.apsEnvironment !== 'development') {
    gaps.push({ id: 'aps_entitlement', present: false });
  }
  gaps.push({ id: 'gms_or_vendor', present: false });
  return gaps;
}

export function companionPushTitleKey(kind: string, payload: Record<string, unknown>): CompanionPushTitleKey | null {
  if (kind === 'approval') return payload.status === 'pending' ? COMPANION_PUSH_TITLE_KEYS.approval : null;
  if (kind === 'agent_complete' || kind === 'agent_cancelled' || kind === 'error') return COMPANION_PUSH_TITLE_KEYS[kind];
  return null;
}
