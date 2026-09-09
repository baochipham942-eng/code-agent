import { z } from 'zod';
import { COMPANION_LIMITS } from '../constants/companion';

export const companionActionSchema = z.enum([
  'message.send',
  'run.cancel',
  'approval.respond',
]);
export type CompanionAction = z.infer<typeof companionActionSchema>;

const id = z.string().trim().min(1).max(COMPANION_LIMITS.idLength);
const commandFields = {
  version: z.literal(1),
  commandId: id,
  deviceId: id,
  scopeEpoch: z.number().int().positive().safe(),
  sessionId: id,
};
export const companionCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...commandFields, action: z.literal('message.send'),
    payload: z.object({ text: z.string().min(1).max(COMPANION_LIMITS.messageLength).refine(value => value.trim().length > 0) }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('run.cancel'),
    payload: z.object({ runId: id }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('approval.respond'),
    expectedRevision: z.number().int().nonnegative().safe(),
    payload: z.object({ requestId: id, decision: z.enum(['approved', 'rejected']), operationDigest: id }).strict(),
  }).strict(),
]);
export type CompanionCommand = z.infer<typeof companionCommandSchema>;

export interface CompanionDevice {
  deviceId: string;
  credentialHash: string;
  scopeEpoch: number;
  scope: readonly string[];
  revokedAt: number | null;
}

export interface CompanionDeviceCredential {
  deviceId: string;
  credential: string;
  scopeEpoch: number;
  scope: readonly string[];
}

export type CompanionCommandState = 'accepted' | 'resolved' | 'rejected' | 'conflict' | 'reconciling';

export interface CompanionCommandRecord {
  deviceId: string;
  commandId: string;
  payloadHash: string;
  action: CompanionAction;
  sessionId: string | null;
  state: CompanionCommandState;
  result: Record<string, unknown>;
  createdAt: number;
}

export interface CompanionEvent {
  eventId: string;
  epoch: number;
  seq: number;
  sessionId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CompanionDecision {
  requestId: string;
  sessionId: string;
  revision: number;
  status: 'pending' | 'approved' | 'rejected' | 'closed';
  resolvedBy: string | null;
  operationDigest: string | null;
}

export type CompanionSubmitResult =
  | { kind: 'accepted'; command: CompanionCommandRecord }
  | { kind: 'replayed'; command: CompanionCommandRecord }
  | { kind: 'conflict'; reason: 'command_payload_mismatch' | 'scope_epoch_mismatch' }
  | { kind: 'rejected'; reason: 'device_revoked' | 'device_unknown' | 'scope_denied' | 'invalid_command' | 'unsupported_action' }
  | { kind: 'approval_conflict'; current: CompanionDecision };

export interface CompanionSyncResult {
  kind: 'events' | 'snapshot_required' | 'revoked';
  epoch: number;
  nextSeq: number;
  events: readonly CompanionEvent[];
}
