import { z } from 'zod';
import { COMPANION_LIMITS } from '../constants/companion';

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
  z.object({ ...commandFields, action: z.literal('session.create'),
    payload: z.object({ title: z.string().trim().min(1).max(160), provider: id, model: id }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('session.rename'),
    payload: z.object({ title: z.string().trim().min(1).max(160) }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('session.archive'),
    payload: z.object({ archived: z.boolean() }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('session.delete'), payload: z.object({}).strict() }).strict(),
  z.object({ ...commandFields, action: z.literal('session.model'),
    payload: z.object({ provider: id, model: id }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('voice.transcribe'),
    payload: z.object({ audioData: z.string().min(1).max(COMPANION_LIMITS.voiceBase64Limit).regex(/^[A-Za-z0-9+/]+={0,2}$/),
      mimeType: z.enum(['audio/aac', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav']),
      durationMs: z.number().positive().max(COMPANION_LIMITS.voiceDurationMs + 5_000) }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('files.prepare'),
    payload: z.object({
      name: z.string().trim().min(1).max(COMPANION_LIMITS.fileNameLength),
      mimeType: z.string().trim().min(1).max(127),
      size: z.number().int().positive().max(COMPANION_LIMITS.fileMaxBytes).safe(),
      sha256: z.string().length(64).regex(/^[a-f0-9]+$/),
    }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('files.chunk'),
    payload: z.object({
      transferId: id,
      offset: z.number().int().nonnegative().safe(),
      data: z.string().min(1).max(COMPANION_LIMITS.fileChunkBase64Limit).regex(/^[A-Za-z0-9+/]+={0,2}$/),
      sha256: z.string().length(64).regex(/^[a-f0-9]+$/),
    }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('files.commit'),
    payload: z.object({ transferId: id, sha256: z.string().length(64).regex(/^[a-f0-9]+$/) }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('files.abort'),
    payload: z.object({ transferId: id }).strict(),
  }).strict(),
  z.object({ ...commandFields, action: z.literal('files.read'),
    payload: z.object({
      artifactId: id,
      version: z.number().int().positive().safe().default(1),
      offset: z.number().int().nonnegative().safe(),
      length: z.number().int().positive().max(COMPANION_LIMITS.fileChunkBytes).safe(),
    }).strict(),
  }).strict(),
]);
export type CompanionCommand = z.infer<typeof companionCommandSchema>;
/** Derived from the command schema so the action list has exactly one definition. */
type CompanionAction = CompanionCommand['action'];

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

type CompanionCommandState = 'accepted' | 'resolved' | 'rejected' | 'conflict' | 'reconciling';

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
