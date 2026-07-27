import { createHash } from 'node:crypto';

import type { Message } from '../../../../shared/contract/message';
import {
  LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
  SessionForkPortabilityError,
} from '../../../../shared/contract/sessionForkPortability';
import type { ConversationMessageSnapshot } from '../../../../shared/contract/conversationBranch';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';

export function failSessionForkPortability(
  code: ConstructorParameters<typeof SessionForkPortabilityError>[0],
  message: string,
): never {
  throw new SessionForkPortabilityError(code, message);
}

export function parseSessionForkJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') {
    failSessionForkPortability('INVALID_ENVELOPE', `${label} is not JSON text`);
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    failSessionForkPortability(
      'INVALID_ENVELOPE',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseSessionForkStringArray(
  value: unknown,
  label: string,
): string[] {
  const parsed = parseSessionForkJson<unknown>(value, label);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    failSessionForkPortability('INVALID_ENVELOPE', `${label} must be a string array`);
  }
  return parsed as string[];
}

export function canonicalSessionForkStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSessionForkStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => (
      `${JSON.stringify(key)}:${canonicalSessionForkStringify(record[key])}`
    ))
    .join(',')}}`;
}

export function sessionForkDigestHex(value: unknown): string {
  return createHash('sha256')
    .update(canonicalSessionForkStringify(value))
    .digest('hex');
}

export function persistedSessionForkOwnerScope(ownerScopeId: string): string | null {
  return ownerScopeId === LOCAL_SESSION_FORK_OWNER_SCOPE_ID ? null : ownerScopeId;
}

export function importedConversationSnapshot(
  message: Message,
): ConversationMessageSnapshot {
  return sanitizeConversationMessageSnapshot(message);
}
