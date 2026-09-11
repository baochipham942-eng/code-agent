import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  CompanionPushDispatchResult,
  CompanionPushEnvironment,
  CompanionPushProvider,
  GeneralizedPushPayload,
} from '../../../shared/contract/companionPush';

const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;

export function wrapPushToken(token: string, key: Buffer): string {
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function unwrapPushToken(wrapped: string, key: Buffer): string | null {
  try {
    const buffer = Buffer.from(wrapped, 'base64url');
    if (buffer.length <= WRAP_IV_BYTES + WRAP_TAG_BYTES) return null;
    const iv = buffer.subarray(0, WRAP_IV_BYTES);
    const tag = buffer.subarray(WRAP_IV_BYTES, WRAP_IV_BYTES + WRAP_TAG_BYTES);
    const encrypted = buffer.subarray(WRAP_IV_BYTES + WRAP_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface PushSendRequest {
  provider: CompanionPushProvider;
  environment: CompanionPushEnvironment;
  token: string;
  payload: GeneralizedPushPayload;
}

/**
 * Missing Auth Key / GMS / vendor channels fail closed. accepted:true is only
 * returned by an injected transport that actually talked to the provider.
 */
function companionPushChannel(provider: CompanionPushProvider, apnsKeyPath: string | null): CompanionPushDispatchResult {
  if (provider === 'fcm' || provider === 'vendor') {
    return { accepted: false, code: 'CHANNEL_MISSING', missing: 'gms_or_vendor' };
  }
  if (!apnsKeyPath) return { accepted: false, code: 'CHANNEL_MISSING', missing: 'apns_auth_key' };
  return { accepted: true };
}

export async function dispatchCompanionPush(
  request: PushSendRequest,
  deps: {
    apnsKeyPath: string | null;
    send?: (request: PushSendRequest) => Promise<CompanionPushDispatchResult>;
  },
): Promise<CompanionPushDispatchResult> {
  const channel = companionPushChannel(request.provider, deps.apnsKeyPath);
  if (!channel.accepted) return channel;
  if (!deps.send) return { accepted: false, code: 'CHANNEL_MISSING', missing: 'apns_auth_key' };
  return deps.send(request);
}
