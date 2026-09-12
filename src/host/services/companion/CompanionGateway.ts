import { companionReadSchema, projectGrant, type CompanionRead } from '../../../shared/contract/companionLibrary';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { applyCompanionSchema } from '../core/database/migrations/companion';
import { companionCommandSchema } from '../../../shared/contract/companion';
import { COMPANION_LIMITS } from '../../../shared/constants/companion';
import type {
  CompanionCommand,
  CompanionCommandRecord,
  CompanionDecision,
  CompanionDeviceCredential,
  CompanionDevice,
  CompanionEvent,
  CompanionSubmitResult,
  CompanionSyncResult,
} from '../../../shared/contract/companion';

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

function credentialDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalCredentialDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface CompanionDispatchResult {
  state?: 'accepted' | 'resolved' | 'rejected' | 'reconciling';
  result?: Record<string, unknown>;
}

export interface CompanionGatewayDeps {
  now?: () => number;
  sessionProject?: (sessionId: string) => string | null;
  /** Live (not tombstoned) session. Deleted sessions must not reappear on /sync. */
  sessionVisible?: (sessionId: string) => boolean;
  read?: (deviceId: string, request: CompanionRead) => Promise<unknown>;
  refreshDecisions?: () => void;
  dispatch?: (command: CompanionCommand) => CompanionDispatchResult;
  /** Must resolve through the same authoritative service used by the desktop. */
  decide?: (command: Extract<CompanionCommand, { action: 'approval.respond' }>) => CompanionSubmitResult;
}

/**
 * Host-side boundary for the first companion vertical slice.
 * It owns identity/epoch checks, command idempotency, event watermarks and
 * approval compare-and-swap. Transport and renderer concerns stay outside.
 */
export class CompanionGateway {
  private readonly now: () => number;
  private readonly dispatch: (command: CompanionCommand) => CompanionDispatchResult;
  private readonly decide: CompanionGatewayDeps['decide'];
  private currentEpoch = 1;
  /** Events published under an older epoch are unreachable: every device re-snapshots. */
  get epoch(): number { return this.currentEpoch; }
  private readonly refreshDecisions: () => void;

  constructor(private readonly db: BetterSqlite3.Database, private readonly deps: CompanionGatewayDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.dispatch = deps.dispatch ?? (() => ({ state: 'rejected', result: { code: 'HOST_UNAVAILABLE' } }));
    this.decide = deps.decide;
    this.refreshDecisions = deps.refreshDecisions ?? (() => {});
    this.ensureSchema();
    // Session mutations commit their DB effect and receipt in one transaction.
    // An interrupted reservation therefore has no committed session mutation.
    // A reservation without a committed receipt means the host may have exited
    // before the command resolved.  Recover every action: leaving message/run/
    // approval rows reconciling strands the phone's durable pending command.
    this.db.prepare(`UPDATE companion_commands SET state = 'rejected', result_json = ?
      WHERE state = 'reconciling'`).run(JSON.stringify({ code: 'COMPANION_INTERRUPTED' }));
    // An approval claim belongs to the uncertain command reservation. Once that
    // reservation is explicitly recovered, release the claim so a fresh
    // command ID can retry the still-pending desktop approval.
    this.db.prepare(`DELETE FROM companion_decision_claims
      WHERE EXISTS (SELECT 1 FROM companion_commands c
        WHERE c.action = 'approval.respond' AND c.state = 'rejected'
          AND json_extract(c.result_json, '$.code') = 'COMPANION_INTERRUPTED'
          AND EXISTS (SELECT 1 FROM companion_decisions d
            WHERE d.request_id = companion_decision_claims.request_id
              AND d.status = 'pending'))`).run();
    const row = this.db.prepare(`SELECT MAX(epoch) AS epoch FROM (
      SELECT COALESCE(MAX(epoch), 1) AS epoch FROM companion_events
      UNION ALL SELECT COALESCE(MAX(scope_epoch), 1) AS epoch FROM companion_devices
    )`).get() as SqlRow | undefined;
    this.currentEpoch = Math.max(1, Number(row?.epoch ?? 1));
    this.pruneEvents();
  }

  registerDevice(device: CompanionDevice): void {
    this.db.prepare(`
      INSERT INTO companion_devices (device_id, credential_hash, scope_json, scope_epoch, revoked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        credential_hash = excluded.credential_hash,
        scope_json = excluded.scope_json,
        scope_epoch = excluded.scope_epoch,
        revoked_at = excluded.revoked_at
    `).run(device.deviceId, device.credentialHash, JSON.stringify(device.scope), device.scopeEpoch, device.revokedAt);
  }

  issueDeviceCredential(scope: readonly string[], scopeEpoch = this.currentEpoch): CompanionDeviceCredential {
    const deviceId = `phone-${randomUUID()}`;
    const credential = randomBytes(32).toString('base64url');
    this.registerDevice({ deviceId, credentialHash: credentialDigest(credential), scopeEpoch, scope, revokedAt: null });
    return { deviceId, credential, scopeEpoch, scope: [...scope] };
  }

  authenticateDevice(deviceId: string, credential: string): boolean {
    const row = this.db.prepare('SELECT credential_hash, revoked_at FROM companion_devices WHERE device_id = ?').get(deviceId) as SqlRow | undefined;
    if (!row || row.revoked_at != null || typeof row.credential_hash !== 'string' || !row.credential_hash) return false;
    return equalCredentialDigest(credentialDigest(credential), row.credential_hash);
  }

  pairIdentity(publicKey: string, scope: readonly string[]): Omit<CompanionDeviceCredential, 'credential'> {
    return this.db.transaction(() => {
      const previous = this.identityDevice(publicKey);
      if (previous) this.revokeDevice(previous.deviceId);
      const { credential: _credential, ...device } = this.issueDeviceCredential(scope);
      this.db.prepare(`INSERT INTO companion_identity_keys (public_key, device_id) VALUES (?, ?)
        ON CONFLICT(public_key) DO UPDATE SET device_id = excluded.device_id`).run(publicKey, device.deviceId);
      return device;
    })();
  }

  identityDevice(publicKey: string): Omit<CompanionDeviceCredential, 'credential'> | null {
    const row = this.db.prepare('SELECT device_id FROM companion_identity_keys WHERE public_key = ?').get(publicKey) as SqlRow | undefined;
    const device = row ? this.getDevice(String(row.device_id)) : null;
    return device?.revokedAt === null
      ? { deviceId: device.deviceId, scopeEpoch: device.scopeEpoch, scope: [...device.scope] } : null;
  }

  pairedDevices(): { deviceId: string; scope: string[] }[] {
    return (this.db.prepare(`SELECT d.device_id, d.scope_json FROM companion_identity_keys k
      JOIN companion_devices d ON d.device_id = k.device_id WHERE d.revoked_at IS NULL`).all() as SqlRow[])
      .map(row => ({ deviceId: String(row.device_id), scope: JSON.parse(String(row.scope_json)) as string[] }));
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
    if (!command.sessionId || !(command.action === 'session.create' ? command.sessionId.startsWith('project:') && device.scope.includes(command.sessionId) : this.canAccessSession(command.deviceId, command.sessionId))) {
      return { kind: 'rejected', reason: 'scope_denied' };
    }

    const payloadHash = digest(command);
    const existing = this.getCommand(command.deviceId, command.commandId);
    if (existing) {
      return existing.payloadHash === payloadHash
        ? { kind: 'replayed', command: existing }
        : { kind: 'conflict', reason: 'command_payload_mismatch' };
    }

    const decide = this.decide;
    if (command.action === 'approval.respond') {
      // A separate companion-only CAS cannot authorize a desktop operation.
      if (!decide) return { kind: 'rejected', reason: 'unsupported_action' };
      this.refreshDecisions();
      const current = this.getDecision(command.payload.requestId);
      if (current?.sessionId !== command.sessionId) return { kind: 'rejected', reason: 'scope_denied' };
      if (current.revision !== command.expectedRevision || current.status !== 'pending' ||
          current.operationDigest !== command.payload.operationDigest) {
        return { kind: 'approval_conflict', current };
      }
    }

    const record: CompanionCommandRecord = {
      deviceId: command.deviceId,
      commandId: command.commandId,
      payloadHash,
      action: command.action,
      sessionId: command.sessionId ?? null,
      state: 'reconciling',
      result: { code: 'COMMAND_RECONCILING' },
      createdAt: this.now(),
    };
    this.db.prepare(`
      INSERT INTO companion_commands
        (device_id, command_id, payload_hash, action, session_id, state, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.deviceId, record.commandId, record.payloadHash, record.action, record.sessionId, record.state, JSON.stringify(record.result), record.createdAt);

    // Commit the reservation before invoking a side effect. A crash or uncertain
    // dispatch keeps this ID reserved across restarts; retries never redispatch.
    // Recovery must consult the durable engine, not infer "not executed".
    try {
      // `decide &&` only restates the guard above (an approval without an authority
      // already returned); it keeps the narrowing here without a non-null assertion,
      // and an impossible miss degrades to dispatch's HOST_UNAVAILABLE, not a crash.
      if (decide && command.action === 'approval.respond') {
        // A different command ID must not redispatch an uncertain logical decision.
        const claimed = this.db.prepare(`INSERT OR IGNORE INTO companion_decision_claims
          (request_id, revision, operation_digest) VALUES (?, ?, ?)`).run(
            command.payload.requestId, command.expectedRevision, command.payload.operationDigest);
        if (!claimed.changes) return { kind: 'replayed', command: record };
        const decision = decide(command);
        if (decision.kind !== 'accepted' && decision.kind !== 'replayed') {
          // The claim exists to stop a *second* command ID from redispatching a decision
          // whose outcome is unknown. A definite non-decision is not that: nothing was
          // authorized, the request is still pending, and leaving the claim behind turns
          // the retry we tell the user to make into a permanent lock — the retry gets
          // IGNOREd above and comes back 'reconciling', which the phone never clears.
          // A same-commandId replay is still caught earlier, by the command row itself.
          this.db.prepare(`DELETE FROM companion_decision_claims
            WHERE request_id = ? AND revision = ? AND operation_digest = ?`).run(
              command.payload.requestId, command.expectedRevision, command.payload.operationDigest);
          record.state = 'rejected';
          record.result = { decision };
        } else {
          record.state = decision.command.state;
          record.result = decision.command.result;
        }
      } else {
        const outcome = this.dispatch(command);
        record.state = outcome.state ?? 'rejected';
        record.result = outcome.result ?? { code: 'HOST_UNAVAILABLE' };
      }
      this.db.prepare(`UPDATE companion_commands SET state = ?, result_json = ? WHERE device_id = ? AND command_id = ? AND state = 'reconciling'`)
        .run(record.state, JSON.stringify(record.result), record.deviceId, record.commandId);
    } catch {
      // The reservation was committed before the side effect, so the row is there;
      // fall back to the in-memory record rather than handing back a null command.
      return { kind: 'replayed', command: this.getCommand(command.deviceId, command.commandId) ?? record };
    }
    return { kind: 'accepted', command: this.deliverCommand(record) };
  }

  // files.read 的分片 base64 是全仓唯一进 result_json 的二进制大对象：返回值携带 data 交给手机，
  // 落库行随即擦掉 data，否则 companion_commands 无 TTL 无上限，按累计传输字节数永久膨胀
  // （claude 复审 Important 3）。手机重放/重读路径不依赖旧行的 data（缓存未命中会以新
  // commandId 重发 files.read，从磁盘重读）。
  private deliverCommand(record: CompanionCommandRecord): CompanionCommandRecord {
    const command = this.getCommand(record.deviceId, record.commandId) ?? record;
    if (command.action === 'files.read' && command.state !== 'reconciling' && 'data' in command.result) {
      this.db.prepare(`UPDATE companion_commands SET result_json = json_remove(result_json, '$.data') WHERE device_id = ? AND command_id = ?`).run(command.deviceId, command.commandId);
    }
    return command;
  }

  commitMutation(command: CompanionCommand, write: () => void, result: Record<string, unknown>): void {
    this.db.transaction(() => {
      const record = this.getCommand(command.deviceId, command.commandId);
      if (record?.state !== 'reconciling') throw new Error('COMPANION_COMMAND_CLOSED');
      write();
      if (command.action === 'session.delete') this.forgetSession(command.sessionId);
      this.settleCommand(command.deviceId, command.commandId, 'accepted', result);
    })();
  }

  settleCommand(deviceId: string, commandId: string, state: 'accepted' | 'rejected', result: Record<string, unknown>): void {
    this.db.prepare(`UPDATE companion_commands SET state = ?, result_json = ?
      WHERE device_id = ? AND command_id = ? AND state = 'reconciling'`).run(state, JSON.stringify(result), deviceId, commandId);
  }

  pendingDecisions(): CompanionDecision[] {
    const rows = this.db.prepare("SELECT request_id FROM companion_decisions WHERE status = 'pending'").all() as SqlRow[];
    return rows.flatMap(row => { const decision = this.getDecision(String(row.request_id)); return decision ? [decision] : []; });
  }

  commandStatus(deviceId: string, commandId: string): CompanionCommandRecord | null {
    const device = this.getDevice(deviceId);
    if (device?.revokedAt !== null) return null;
    const command = this.getCommand(deviceId, commandId);
    const allowed = command?.sessionId && (command.action === 'session.create' ? device.scope.includes(command.sessionId) : this.canAccessSession(deviceId, command.sessionId)) ? command : null;
    return allowed ? this.deliverCommand(allowed) : null;
  }

  hasLiveDevices(): boolean {
    return !!this.db.prepare('SELECT 1 FROM companion_devices WHERE revoked_at IS NULL LIMIT 1').get();
  }

  forgetSession(sessionId: string): void {
    this.db.prepare('DELETE FROM companion_events WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM companion_decisions WHERE session_id = ?').run(sessionId);
    this.db.prepare('INSERT OR IGNORE INTO companion_session_cleanup (session_id) VALUES (?)').run(sessionId);
  }

  /** Batch form of isForgotten(): the list path filters a whole page without compiling SQL per session. */
  forgottenSessions(): ReadonlySet<string> {
    const rows = this.db.prepare('SELECT session_id FROM companion_session_cleanup').all() as { session_id: string }[];
    return new Set(rows.map(row => row.session_id));
  }

  publish(sessionId: string | null, kind: string, payload: Record<string, unknown>, now = this.now()): CompanionEvent {
    this.pruneEvents(now);
    const seq = this.nextSeq();
    const event: CompanionEvent = {
      eventId: randomUUID(),
      epoch: this.currentEpoch,
      seq: seq + 1,
      sessionId,
      kind,
      payload,
      createdAt: now,
    };
    if (!this.hasLiveDevices()) return { ...event, seq };
    this.db.prepare(`
      INSERT INTO companion_events (event_id, epoch, seq, session_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.eventId, event.epoch, event.seq, event.sessionId, event.kind, JSON.stringify(event.payload), event.createdAt);
    this.pruneEvents(now);
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

  syncForDevice(deviceId: string, epoch: number, afterSeq: number): CompanionSyncResult {
    const device = this.getDevice(deviceId);
    if (device?.revokedAt !== null) return { kind: 'revoked', epoch, nextSeq: afterSeq, events: [] };
    // Page the underlying stream first, then filter. Advance over unauthorized
    // rows too, so one busy unshared session cannot pin a phone's cursor.
    this.refreshDecisions();
    const page = this.sync(epoch, afterSeq, COMPANION_LIMITS.syncPageSize);
    return { ...page, events: page.events.filter(event => event.sessionId !== null && this.canAccessSession(deviceId, event.sessionId)) };
  }

  canAccessSession(deviceId: string, sessionId: string): boolean {
    const device = this.getDevice(deviceId);
    if (device?.revokedAt !== null || sessionId.startsWith('project:')) return false;
    if (this.isForgotten(sessionId)) return false;
    if (this.deps.sessionVisible && !this.deps.sessionVisible(sessionId)) return false;
    if (device.scope.includes(sessionId)) return true;
    const project = this.deps.sessionProject?.(sessionId);
    return !!project && device.scope.includes(projectGrant(project));
  }

  grants(deviceId: string): readonly string[] {
    const device = this.getDevice(deviceId);
    return device?.revokedAt === null ? device.scope : [];
  }

  async read(deviceId: string, raw: unknown): Promise<unknown> {
    if (!this.grants(deviceId).length || !this.deps.read) throw new Error('COMPANION_LIBRARY_UNAVAILABLE');
    const request = companionReadSchema.parse(raw);
    if ((request.kind === 'history' || request.kind === 'artifacts') && !this.canAccessSession(deviceId, request.sessionId)) throw new Error('COMPANION_SCOPE_DENIED');
    const result = await this.deps.read(deviceId, request);
    if (!this.grants(deviceId).length || ((request.kind === 'history' || request.kind === 'artifacts') && !this.canAccessSession(deviceId, request.sessionId))) throw new Error('COMPANION_SCOPE_DENIED');
    return result;
  }

  private getDevice(deviceId: string): CompanionDevice | null {
    const row = this.db.prepare('SELECT device_id, credential_hash, scope_json, scope_epoch, revoked_at FROM companion_devices WHERE device_id = ?').get(deviceId) as SqlRow | undefined;
    if (!row) return null;
    return { deviceId: String(row.device_id), credentialHash: String(row.credential_hash ?? ''), scope: JSON.parse(String(row.scope_json)) as string[], scopeEpoch: Number(row.scope_epoch), revokedAt: row.revoked_at == null ? null : Number(row.revoked_at) };
  }

  private getCommand(deviceId: string, commandId: string): CompanionCommandRecord | null {
    const row = this.db.prepare('SELECT * FROM companion_commands WHERE device_id = ? AND command_id = ?').get(deviceId, commandId) as SqlRow | undefined;
    if (!row) return null;
    return { deviceId: String(row.device_id), commandId: String(row.command_id), payloadHash: String(row.payload_hash), action: row.action as CompanionCommandRecord['action'], sessionId: row.session_id == null ? null : String(row.session_id), state: row.state as CompanionCommandRecord['state'], result: JSON.parse(String(row.result_json)) as Record<string, unknown>, createdAt: Number(row.created_at) };
  }

  getDecision(requestId: string): CompanionDecision | null {
    const row = this.db.prepare('SELECT * FROM companion_decisions WHERE request_id = ?').get(requestId) as SqlRow | undefined;
    if (!row) return null;
    return { requestId: String(row.request_id), sessionId: String(row.session_id), revision: Number(row.revision), status: row.status as CompanionDecision['status'], resolvedBy: row.resolved_by == null ? null : String(row.resolved_by), operationDigest: row.operation_digest == null ? null : String(row.operation_digest) };
  }

  private nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM companion_events WHERE epoch = ?').get(this.currentEpoch) as SqlRow;
    return Number(row.seq);
  }

  private isForgotten(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM companion_session_cleanup WHERE session_id = ?').get(sessionId);
  }

  private pruneEvents(now = this.now()): void {
    this.db.prepare('DELETE FROM companion_events WHERE created_at < ?').run(now - COMPANION_LIMITS.eventTtlMs);
    this.db.prepare('DELETE FROM companion_events WHERE epoch < ?').run(this.currentEpoch);
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM companion_events').get() as SqlRow).n);
    if (count <= COMPANION_LIMITS.eventMaxRows) return;
    this.db.prepare(`
      DELETE FROM companion_events WHERE event_id IN (
        SELECT event_id FROM companion_events ORDER BY created_at ASC, epoch ASC, seq ASC LIMIT ?
      )
    `).run(count - COMPANION_LIMITS.eventMaxRows);
  }

  private ensureSchema(): void {
    applyCompanionSchema(this.db);
  }
}
