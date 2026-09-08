import { z } from 'zod';

export const companionActionSchema = z.enum([
  'message.send',
  'run.cancel',
  'approval.respond',
]);
export type CompanionAction = z.infer<typeof companionActionSchema>;

export const companionCommandSchema = z.object({
  version: z.literal(1),
  commandId: z.string().min(1),
  deviceId: z.string().min(1),
  scopeEpoch: z.number().int().nonnegative(),
  sessionId: z.string().min(1).optional(),
  action: companionActionSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});
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

export type CompanionCommandState = 'accepted' | 'resolved' | 'rejected' | 'conflict';

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
  status: 'pending' | 'approved' | 'rejected';
  resolvedBy: string | null;
  operationDigest: string | null;
}

export type CompanionSubmitResult =
  | { kind: 'accepted'; command: CompanionCommandRecord }
  | { kind: 'replayed'; command: CompanionCommandRecord }
  | { kind: 'conflict'; reason: 'command_payload_mismatch' | 'scope_epoch_mismatch' }
  | { kind: 'rejected'; reason: 'device_revoked' | 'device_unknown' | 'scope_denied' | 'invalid_command' }
  | { kind: 'approval_conflict'; current: CompanionDecision };

export interface CompanionSyncResult {
  kind: 'events' | 'snapshot_required' | 'revoked';
  epoch: number;
  nextSeq: number;
  events: readonly CompanionEvent[];
}
