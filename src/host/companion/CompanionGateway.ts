import { createHash, randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { applyCompanionSchema } from '../services/core/database/migrations/companion';
import { companionCommandSchema } from '../../shared/contract/companion';
import type {
  CompanionCommand,
  CompanionCommandRecord,
  CompanionDecision,
  CompanionDevice,
  CompanionEvent,
  CompanionSubmitResult,
  CompanionSyncResult,
} from '../../shared/contract/companion';

type SqlRow = Record<string, unknown>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export interface CompanionDispatchResult {
  state?: 'accepted' | 'resolved' | 'rejected';
  result?: Record<string, unknown>;
}

export interface CompanionGatewayDeps {
  now?: () => number;
  dispatch?: (command: CompanionCommand) => CompanionDispatchResult;
}

/**
 * Host-side boundary for the first companion vertical slice.
 * It owns identity/epoch checks, command idempotency, event watermarks and
 * approval compare-and-swap. Transport and renderer concerns stay outside.
 */
export class CompanionGateway {
  private readonly now: () => number;
  private readonly dispatch: (command: CompanionCommand) => CompanionDispatchResult;
  private currentEpoch = 1;

  constructor(private readonly db: BetterSqlite3.Database, deps: CompanionGatewayDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.dispatch = deps.dispatch ?? (() => ({ state: 'accepted' }));
    this.ensureSchema();
    const row = this.db.prepare('SELECT COALESCE(MAX(epoch), 1) AS epoch FROM companion_events').get() as SqlRow | undefined;
    this.currentEpoch = Math.max(1, Number(row?.epoch ?? 1));
  }

  registerDevice(device: CompanionDevice): void {
    this.db.prepare(`
      INSERT INTO companion_devices (device_id, scope_json, scope_epoch, revoked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        scope_json = excluded.scope_json,
        scope_epoch = excluded.scope_epoch,
        revoked_at = excluded.revoked_at
    `).run(device.deviceId, JSON.stringify(device.scope), device.scopeEpoch, device.revokedAt);
  }

  revokeDevice(deviceId: string, now = this.now()): number {
    const nextEpoch = this.currentEpoch + 1;
    const changes = this.db.prepare(`
      UPDATE companion_devices SET revoked_at = ?, scope_epoch = ? WHERE device_id = ?
    `).run(now, nextEpoch, deviceId).changes;
    if (changes > 0) this.currentEpoch = nextEpoch;
    return changes;
  }

  submit(rawCommand: unknown): CompanionSubmitResult {
    const parsed = companionCommandSchema.safeParse(rawCommand);
    if (!parsed.success) return { kind: 'rejected', reason: 'invalid_command' };
    const command = parsed.data;
    const device = this.getDevice(command.deviceId);
    if (!device) return { kind: 'rejected', reason: 'device_unknown' };
    if (device.revokedAt !== null) return { kind: 'rejected', reason: 'device_revoked' };
    if (command.scopeEpoch !== device.scopeEpoch) return { kind: 'conflict', reason: 'scope_epoch_mismatch' };
    if (!command.sessionId || !device.scope.includes(command.sessionId)) {
      return { kind: 'rejected', reason: 'scope_denied' };
    }

    const payloadHash = digest({ action: command.action, sessionId: command.sessionId ?? null, payload: command.payload });
    const existing = this.getCommand(command.deviceId, command.commandId);
    if (existing) {
      return existing.payloadHash === payloadHash
        ? { kind: 'replayed', command: existing }
        : { kind: 'conflict', reason: 'command_payload_mismatch' };
    }

    if (command.action === 'approval.respond') {
      const decision = this.resolveApproval(command);
      if (decision) return decision;
    }

    const outcome = this.dispatch(command);
    const record: CompanionCommandRecord = {
      deviceId: command.deviceId,
      commandId: command.commandId,
      payloadHash,
      action: command.action,
      sessionId: command.sessionId ?? null,
      state: outcome.state ?? 'accepted',
      result: outcome.result ?? { accepted: true },
      createdAt: this.now(),
    };
    this.db.prepare(`
      INSERT INTO companion_commands
        (device_id, command_id, payload_hash, action, session_id, state, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.deviceId, record.commandId, record.payloadHash, record.action, record.sessionId, record.state, JSON.stringify(record.result), record.createdAt);
    return { kind: 'accepted', command: record };
  }

  publish(sessionId: string | null, kind: string, payload: Record<string, unknown>, now = this.now()): CompanionEvent {
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM companion_events WHERE epoch = ?').get(this.currentEpoch) as SqlRow;
    const event: CompanionEvent = {
      eventId: randomUUID(),
      epoch: this.currentEpoch,
      seq: Number(seqRow.seq) + 1,
      sessionId,
      kind,
      payload,
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO companion_events (event_id, epoch, seq, session_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.eventId, event.epoch, event.seq, event.sessionId, event.kind, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  registerDecision(decision: CompanionDecision): void {
    this.db.prepare(`
      INSERT INTO companion_decisions
        (request_id, session_id, revision, status, resolved_by, operation_digest)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        session_id = excluded.session_id,
        revision = excluded.revision,
        status = excluded.status,
        resolved_by = excluded.resolved_by,
        operation_digest = excluded.operation_digest
    `).run(
      decision.requestId,
      decision.sessionId,
      decision.revision,
      decision.status,
      decision.resolvedBy,
      decision.operationDigest,
    );
  }

  sync(epoch: number, afterSeq: number, limit = 100): CompanionSyncResult {
    if (epoch !== this.currentEpoch) return { kind: 'snapshot_required', epoch: this.currentEpoch, nextSeq: this.nextSeq(), events: [] };
    const rows = this.db.prepare(`
      SELECT event_id, epoch, seq, session_id, kind, payload_json, created_at
      FROM companion_events WHERE epoch = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(epoch, afterSeq, limit) as SqlRow[];
    const events = rows.map((row) => ({
      eventId: String(row.event_id), epoch: Number(row.epoch), seq: Number(row.seq),
      sessionId: row.session_id == null ? null : String(row.session_id), kind: String(row.kind),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: Number(row.created_at),
    }));
    return { kind: 'events', epoch, nextSeq: events.at(-1)?.seq ?? afterSeq, events };
  }

  private resolveApproval(command: CompanionCommand): CompanionSubmitResult | null {
    const payload = command.payload as { requestId?: unknown; decision?: unknown; operationDigest?: unknown };
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
    const decision = payload.decision === 'approved' || payload.decision === 'rejected' ? payload.decision : null;
    if (!requestId || !decision || command.expectedRevision === undefined || !command.sessionId) {
      return { kind: 'rejected', reason: 'invalid_command' };
    }
    const current = this.getDecision(requestId);
    if (current?.status !== 'pending' || current.revision !== command.expectedRevision) {
      return { kind: 'approval_conflict', current: current ?? {
        requestId, sessionId: command.sessionId, revision: command.expectedRevision, status: 'rejected', resolvedBy: null, operationDigest: null,
      } };
    }
    const changes = this.db.prepare(`UPDATE companion_decisions SET status = ?, resolved_by = ?, operation_digest = ? WHERE request_id = ? AND status = 'pending' AND revision = ?`)
      .run(decision, command.deviceId, typeof payload.operationDigest === 'string' ? payload.operationDigest : null, requestId, command.expectedRevision);
    if (changes.changes !== 1) {
      return { kind: 'approval_conflict', current: this.getDecision(requestId) ?? {
        requestId, sessionId: command.sessionId, revision: command.expectedRevision, status: 'rejected', resolvedBy: null, operationDigest: null,
      } };
    }
    return null;
  }

  private getDevice(deviceId: string): CompanionDevice | null {
    const row = this.db.prepare('SELECT device_id, scope_json, scope_epoch, revoked_at FROM companion_devices WHERE device_id = ?').get(deviceId) as SqlRow | undefined;
    if (!row) return null;
    return { deviceId: String(row.device_id), scope: JSON.parse(String(row.scope_json)) as string[], scopeEpoch: Number(row.scope_epoch), revokedAt: row.revoked_at == null ? null : Number(row.revoked_at) };
  }

  private getCommand(deviceId: string, commandId: string): CompanionCommandRecord | null {
    const row = this.db.prepare('SELECT * FROM companion_commands WHERE device_id = ? AND command_id = ?').get(deviceId, commandId) as SqlRow | undefined;
    if (!row) return null;
    return { deviceId: String(row.device_id), commandId: String(row.command_id), payloadHash: String(row.payload_hash), action: row.action as CompanionCommandRecord['action'], sessionId: row.session_id == null ? null : String(row.session_id), state: row.state as CompanionCommandRecord['state'], result: JSON.parse(String(row.result_json)) as Record<string, unknown>, createdAt: Number(row.created_at) };
  }

  private getDecision(requestId: string): CompanionDecision | null {
    const row = this.db.prepare('SELECT * FROM companion_decisions WHERE request_id = ?').get(requestId) as SqlRow | undefined;
    if (!row) return null;
    return { requestId: String(row.request_id), sessionId: String(row.session_id), revision: Number(row.revision), status: row.status as CompanionDecision['status'], resolvedBy: row.resolved_by == null ? null : String(row.resolved_by), operationDigest: row.operation_digest == null ? null : String(row.operation_digest) };
  }

  private nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM companion_events WHERE epoch = ?').get(this.currentEpoch) as SqlRow;
    return Number(row.seq);
  }

  private ensureSchema(): void {
    applyCompanionSchema(this.db);
  }
}
