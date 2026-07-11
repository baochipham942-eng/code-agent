import type BetterSqlite3 from 'better-sqlite3';
import {
  assertRunEnvelope,
  canTransitionRunStatus,
  isTerminalRunStatus,
  type ChildRunRef,
  type PendingOperation,
  type RunAttempt,
  type RunCheckpoint,
  type RunEnvelope,
  type RunOwnerLease,
} from '../../../../shared/contract/durableRun';
import type {
  CheckpointCommit,
  DurableRunStores,
  EventAppendRequest,
  RecoveryProjectionReplace,
  RunLeaseClaim,
  RunLeaseClaimResult,
  RunTransition,
  StoredRunEvent,
  TerminalCommit,
} from '../../../runtime/durableRunStores';
import { applyDurableRunMigrationDraft } from '../database/migrations/durableRun';

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function rowToEnvelope(row: Row): RunEnvelope {
  return parseJson<RunEnvelope>(row.envelope_json);
}

function rowToAttempt(row: Row): RunAttempt {
  return {
    runId: String(row.run_id),
    attempt: Number(row.attempt),
    processInstanceId: String(row.process_instance_id),
    ownerId: String(row.owner_id),
    ownerEpoch: Number(row.owner_epoch),
    status: row.status as RunAttempt['status'],
    resumedFromCheckpointSeq: row.resumed_from_checkpoint_seq == null
      ? undefined : Number(row.resumed_from_checkpoint_seq),
    recoveryReason: row.recovery_reason == null
      ? undefined : row.recovery_reason as RunAttempt['recoveryReason'],
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
  };
}

function rowToOperation(row: Row): PendingOperation {
  return {
    runId: String(row.run_id),
    operationId: String(row.operation_id),
    attempt: Number(row.attempt),
    kind: row.kind as PendingOperation['kind'],
    status: row.status as PendingOperation['status'],
    idempotencyKey: String(row.idempotency_key),
    sideEffect: Number(row.side_effect) === 1,
    requiresHumanConfirmation: Number(row.requires_human_confirmation) === 1 || undefined,
    inputDigest: row.input_digest == null ? undefined : String(row.input_digest),
    providerOperationId: row.provider_operation_id == null ? undefined : String(row.provider_operation_id),
    resultRef: row.result_ref == null ? undefined : String(row.result_ref),
    preparedAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToChild(row: Row): ChildRunRef {
  return {
    parentRunId: String(row.parent_run_id),
    childRunId: String(row.child_run_id),
    relation: row.relation as ChildRunRef['relation'],
    status: row.status as ChildRunRef['status'],
    createdAt: Number(row.created_at),
    terminalAt: row.terminal_at == null ? undefined : Number(row.terminal_at),
  };
}

function rowToCheckpoint(row: Row): RunCheckpoint {
  return {
    runId: String(row.run_id),
    checkpointSeq: Number(row.checkpoint_seq),
    attempt: Number(row.attempt),
    eventSeq: Number(row.event_seq),
    status: row.status as RunCheckpoint['status'],
    cursor: parseJson<RunCheckpoint['cursor']>(row.cursor_json),
    state: parseJson(row.state_json),
    checksum: String(row.checksum),
    createdAt: Number(row.created_at),
  };
}

export class DurableRunRepository implements DurableRunStores {
  constructor(private readonly db: BetterSqlite3.Database) {}

  migrate(): void {
    applyDurableRunMigrationDraft(this.db);
  }

  async create(envelope: RunEnvelope, attempt: RunAttempt): Promise<void> {
    assertRunEnvelope(envelope);
    const owner = envelope.owner;
    if (!owner || attempt.ownerEpoch !== owner.epoch || attempt.attempt !== envelope.attempt) {
      throw new Error('Initial durable run attempt must match its owner lease');
    }
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO durable_runs (
        run_id, session_id, parent_run_id, engine_kind, engine_ref_json, status, attempt,
        next_event_seq, checkpoint_seq, envelope_json, owner_id, process_instance_id,
        owner_epoch, lease_expires_at, terminal_event_seq, terminal_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
        .run(
          envelope.runId, envelope.sessionId, envelope.parentRunId ?? null, envelope.engine.kind,
          stringify(envelope.engine), envelope.status, envelope.attempt, envelope.cursor.nextEventSeq,
          envelope.cursor.checkpointSeq, stringify(envelope), owner.ownerId,
          owner.processInstanceId, owner.epoch, owner.leaseExpiresAt,
          envelope.createdAt, envelope.updatedAt,
        );
      this.insertAttempt(attempt);
    })();
  }

  async get(runId: string): Promise<RunEnvelope | null> {
    const row = this.db.prepare('SELECT envelope_json FROM durable_runs WHERE run_id = ?').get(runId) as Row | undefined;
    return row ? rowToEnvelope(row) : null;
  }

  async listRecoverable(now: number, limit: number): Promise<RunEnvelope[]> {
    const rows = this.db.prepare(`SELECT envelope_json FROM durable_runs
      WHERE status IN ('running','waiting','recovering') AND lease_expires_at <= ?
      ORDER BY updated_at ASC LIMIT ?`).all(now, limit) as Row[];
    return rows.map(rowToEnvelope);
  }

  async claimLease(claim: RunLeaseClaim): Promise<RunLeaseClaimResult | null> {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM durable_runs WHERE run_id = ?').get(claim.runId) as Row | undefined;
      if (!row || isTerminalRunStatus(row.status as RunEnvelope['status'])) return null;
      const epoch = Number(row.owner_epoch);
      const expiry = row.lease_expires_at == null ? 0 : Number(row.lease_expires_at);
      if (epoch !== (claim.expectedEpoch ?? 0) || expiry > claim.now) return null;

      const previous = rowToEnvelope(row);
      const nextEpoch = epoch + 1;
      const nextAttempt = Number(row.attempt) + 1;
      const owner: RunOwnerLease = {
        ownerId: claim.ownerId,
        processInstanceId: claim.processInstanceId,
        epoch: nextEpoch,
        leaseExpiresAt: claim.now + claim.leaseDurationMs,
      };
      const envelope: RunEnvelope = {
        ...previous,
        status: 'recovering',
        attempt: nextAttempt,
        owner,
        terminal: undefined,
        updatedAt: claim.now,
      };
      const attempt: RunAttempt = {
        runId: claim.runId,
        attempt: nextAttempt,
        processInstanceId: claim.processInstanceId,
        ownerId: claim.ownerId,
        ownerEpoch: nextEpoch,
        status: 'active',
        resumedFromCheckpointSeq: previous.cursor.checkpointSeq || undefined,
        recoveryReason: 'lease_expired',
        startedAt: claim.now,
      };
      this.db.prepare(`UPDATE durable_run_attempts SET status = 'lost', ended_at = ?
        WHERE run_id = ? AND attempt = ? AND status IN ('starting','active')`)
        .run(claim.now, claim.runId, previous.attempt);
      const changed = this.db.prepare(`UPDATE durable_runs SET status = 'recovering', attempt = ?,
        owner_id = ?, process_instance_id = ?, owner_epoch = ?, lease_expires_at = ?,
        envelope_json = ?, updated_at = ? WHERE run_id = ? AND owner_epoch = ? AND lease_expires_at <= ?`)
        .run(nextAttempt, owner.ownerId, owner.processInstanceId, nextEpoch, owner.leaseExpiresAt,
          stringify(envelope), claim.now, claim.runId, epoch, claim.now);
      if (changed.changes !== 1) return null;
      this.insertAttempt(attempt);
      return { envelope, owner, attempt };
    })();
  }

  async renewLease(runId: string, owner: RunOwnerLease, leaseExpiresAt: number): Promise<boolean> {
    const envelope = await this.get(runId);
    if (!envelope || isTerminalRunStatus(envelope.status)) return false;
    const next = { ...envelope, owner: { ...owner, leaseExpiresAt }, updatedAt: Date.now() };
    const result = this.db.prepare(`UPDATE durable_runs SET lease_expires_at = ?, envelope_json = ?, updated_at = ?
      WHERE run_id = ? AND owner_id = ? AND process_instance_id = ? AND owner_epoch = ?`)
      .run(leaseExpiresAt, stringify(next), next.updatedAt, runId, owner.ownerId, owner.processInstanceId, owner.epoch);
    return result.changes === 1;
  }

  async transition(input: RunTransition): Promise<RunEnvelope | null> {
    const envelope = await this.get(input.runId);
    if (!envelope || envelope.status !== input.expectedStatus || envelope.owner?.epoch !== input.expectedOwnerEpoch) return null;
    if (!canTransitionRunStatus(envelope.status, input.nextStatus)) throw new Error(`Invalid run transition ${envelope.status} -> ${input.nextStatus}`);
    const next = { ...envelope, status: input.nextStatus, updatedAt: input.updatedAt };
    const result = this.db.prepare(`UPDATE durable_runs SET status = ?, envelope_json = ?, updated_at = ?
      WHERE run_id = ? AND status = ? AND owner_epoch = ?`)
      .run(input.nextStatus, stringify(next), input.updatedAt, input.runId, input.expectedStatus, input.expectedOwnerEpoch);
    return result.changes === 1 ? next : null;
  }

  async releaseLease(runId: string, owner: RunOwnerLease, now: number): Promise<boolean> {
    const envelope = await this.get(runId);
    if (!envelope || envelope.owner?.epoch !== owner.epoch) return false;
    const next = { ...envelope, owner: { ...owner, leaseExpiresAt: now }, updatedAt: now };
    const result = this.db.prepare(`UPDATE durable_runs SET lease_expires_at = ?, envelope_json = ?, updated_at = ?
      WHERE run_id = ? AND owner_id = ? AND process_instance_id = ? AND owner_epoch = ?`)
      .run(now, stringify(next), now, runId, owner.ownerId, owner.processInstanceId, owner.epoch);
    return result.changes === 1;
  }

  async getAttempt(runId: string, attempt: number): Promise<RunAttempt | null> {
    const row = this.db.prepare('SELECT * FROM durable_run_attempts WHERE run_id = ? AND attempt = ?')
      .get(runId, attempt) as Row | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async listPendingOperations(runId: string): Promise<PendingOperation[]> {
    return (this.db.prepare('SELECT * FROM durable_run_pending_operations WHERE run_id = ? ORDER BY created_at, operation_id')
      .all(runId) as Row[]).map(rowToOperation);
  }

  async listChildRuns(runId: string): Promise<ChildRunRef[]> {
    return (this.db.prepare('SELECT * FROM durable_run_children WHERE parent_run_id = ? ORDER BY created_at, child_run_id')
      .all(runId) as Row[]).map(rowToChild);
  }

  async replaceRecoveryProjection(input: RecoveryProjectionReplace): Promise<RunEnvelope> {
    return this.db.transaction(() => {
      const envelope = this.requireOwnedEnvelope(input.runId, input.attempt, input.expectedOwnerEpoch);
      const next: RunEnvelope = {
        ...envelope,
        status: input.status,
        pendingOperations: input.pendingOperations,
        updatedAt: input.updatedAt,
      };
      this.replaceOperations(input.runId, input.pendingOperations);
      this.db.prepare('UPDATE durable_runs SET status = ?, envelope_json = ?, updated_at = ? WHERE run_id = ? AND owner_epoch = ?')
        .run(input.status, stringify(next), input.updatedAt, input.runId, input.expectedOwnerEpoch);
      return next;
    })();
  }

  async append(input: EventAppendRequest): Promise<RunEnvelope['cursor']> {
    return this.db.transaction(() => {
      const envelope = this.requireOwnedEnvelope(input.runId, input.attempt, input.expectedOwnerEpoch);
      if (envelope.cursor.nextEventSeq !== input.expectedNextSeq) throw new Error('Event append fenced by stale cursor');
      let seq = input.expectedNextSeq;
      for (const event of input.events) {
        this.db.prepare(`INSERT INTO durable_run_events (run_id, seq, attempt, event_type, event_json, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(input.runId, seq, input.attempt, event.type, stringify(event.payload), event.recordedAt);
        seq += 1;
      }
      const cursor = { ...envelope.cursor, nextEventSeq: seq };
      const next = { ...envelope, cursor, updatedAt: input.events.at(-1)?.recordedAt ?? envelope.updatedAt };
      this.db.prepare('UPDATE durable_runs SET next_event_seq = ?, envelope_json = ?, updated_at = ? WHERE run_id = ? AND owner_epoch = ?')
        .run(seq, stringify(next), next.updatedAt, input.runId, input.expectedOwnerEpoch);
      return cursor;
    })();
  }

  async read(runId: string, afterSeq: number, limit: number): Promise<StoredRunEvent[]> {
    return (this.db.prepare(`SELECT * FROM durable_run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(runId, afterSeq, limit) as Row[]).map((row) => ({
        runId: String(row.run_id), seq: Number(row.seq), attempt: Number(row.attempt),
        type: String(row.event_type), payload: parseJson(row.event_json), recordedAt: Number(row.recorded_at),
      }));
  }

  async getLatest(runId: string): Promise<RunCheckpoint | null> {
    const row = this.db.prepare(`SELECT * FROM durable_run_checkpoints WHERE run_id = ? ORDER BY checkpoint_seq DESC LIMIT 1`)
      .get(runId) as Row | undefined;
    return row ? rowToCheckpoint(row) : null;
  }

  async commit(input: CheckpointCommit): Promise<RunCheckpoint> {
    return this.db.transaction(() => {
      const envelope = this.requireOwnedEnvelope(input.runId, input.attempt, input.expectedOwnerEpoch);
      if (isTerminalRunStatus(envelope.status)) throw new Error('Terminal run cannot checkpoint');
      if (envelope.cursor.nextEventSeq !== input.expectedNextEventSeq) throw new Error('Checkpoint fenced by stale cursor');
      if (input.checkpoint.checkpointSeq !== envelope.cursor.checkpointSeq + 1) throw new Error('Checkpoint sequence mismatch');
      let seq = input.expectedNextEventSeq;
      for (const event of input.events) {
        this.db.prepare(`INSERT INTO durable_run_events (run_id, seq, attempt, event_type, event_json, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(input.runId, seq, input.attempt, event.type, stringify(event.payload), event.recordedAt);
        seq += 1;
      }
      if (input.checkpoint.eventSeq !== seq - 1 || input.checkpoint.cursor.nextEventSeq !== seq) {
        throw new Error('Checkpoint event boundary mismatch');
      }
      this.db.prepare(`INSERT INTO durable_run_checkpoints
        (run_id, checkpoint_seq, attempt, event_seq, status, cursor_json, state_json, checksum, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.runId, input.checkpoint.checkpointSeq, input.attempt, input.checkpoint.eventSeq,
          input.checkpoint.status, stringify(input.checkpoint.cursor), stringify(input.checkpoint.state),
          input.checkpoint.checksum, input.checkpoint.createdAt);
      this.replaceOperations(input.runId, input.pendingOperations);
      this.replaceChildren(input.runId, input.childRuns);
      const next: RunEnvelope = {
        ...envelope, status: input.checkpoint.status, cursor: input.checkpoint.cursor,
        pendingOperations: input.pendingOperations, childRuns: input.childRuns,
        updatedAt: input.checkpoint.createdAt,
      };
      this.db.prepare(`UPDATE durable_runs SET status = ?, next_event_seq = ?, checkpoint_seq = ?,
        envelope_json = ?, updated_at = ? WHERE run_id = ? AND owner_epoch = ?`)
        .run(next.status, next.cursor.nextEventSeq, next.cursor.checkpointSeq, stringify(next), next.updatedAt,
          input.runId, input.expectedOwnerEpoch);
      return input.checkpoint;
    })();
  }

  async commitTerminal(input: TerminalCommit): Promise<RunEnvelope> {
    return this.db.transaction(() => {
      const envelope = this.requireOwnedEnvelope(input.runId, input.attempt, input.expectedOwnerEpoch);
      if (!canTransitionRunStatus(envelope.status, input.status)) throw new Error(`Invalid terminal transition ${envelope.status} -> ${input.status}`);
      if (envelope.cursor.nextEventSeq !== input.expectedNextEventSeq) throw new Error('Terminal write fenced by stale cursor');
      const terminalSeq = input.expectedNextEventSeq;
      const cursor = { ...envelope.cursor, nextEventSeq: terminalSeq + 1 };
      const next: RunEnvelope = {
        ...envelope, status: input.status, cursor,
        terminal: { status: input.status, eventSeq: terminalSeq, at: input.terminalAt, reason: input.reason },
        updatedAt: input.terminalAt,
      };
      assertRunEnvelope(next);
      this.db.prepare(`INSERT INTO durable_run_events (run_id, seq, attempt, event_type, event_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.runId, terminalSeq, input.attempt, input.event.type, stringify(input.event.payload), input.event.recordedAt);
      const changed = this.db.prepare(`UPDATE durable_runs SET status = ?, next_event_seq = ?, terminal_event_seq = ?,
        terminal_at = ?, envelope_json = ?, updated_at = ? WHERE run_id = ? AND owner_epoch = ? AND status = ?`)
        .run(input.status, cursor.nextEventSeq, terminalSeq, input.terminalAt, stringify(next), input.terminalAt,
          input.runId, input.expectedOwnerEpoch, envelope.status);
      if (changed.changes !== 1) throw new Error('Terminal write fenced by stale owner');
      this.db.prepare(`UPDATE durable_run_attempts SET status = 'ended', ended_at = ? WHERE run_id = ? AND attempt = ?`)
        .run(input.terminalAt, input.runId, input.attempt);
      return next;
    })();
  }

  private requireOwnedEnvelope(runId: string, attempt: number, ownerEpoch: number): RunEnvelope {
    const row = this.db.prepare('SELECT * FROM durable_runs WHERE run_id = ?').get(runId) as Row | undefined;
    if (!row) throw new Error(`Unknown durable run: ${runId}`);
    const envelope = rowToEnvelope(row);
    if (envelope.attempt !== attempt || envelope.owner?.epoch !== ownerEpoch) {
      throw new Error(`Durable run write fenced by stale owner: ${runId}`);
    }
    return envelope;
  }

  private insertAttempt(attempt: RunAttempt): void {
    this.db.prepare(`INSERT INTO durable_run_attempts
      (run_id, attempt, process_instance_id, owner_id, owner_epoch, status,
       resumed_from_checkpoint_seq, recovery_reason, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attempt.runId, attempt.attempt, attempt.processInstanceId, attempt.ownerId,
        attempt.ownerEpoch, attempt.status, attempt.resumedFromCheckpointSeq ?? null,
        attempt.recoveryReason ?? null, attempt.startedAt, attempt.endedAt ?? null);
  }

  private replaceOperations(runId: string, operations: PendingOperation[]): void {
    this.db.prepare('DELETE FROM durable_run_pending_operations WHERE run_id = ?').run(runId);
    const insert = this.db.prepare(`INSERT INTO durable_run_pending_operations
      (run_id, operation_id, attempt, kind, status, idempotency_key, side_effect,
       requires_human_confirmation, input_json, input_digest, provider_operation_id,
       result_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const operation of operations) {
      insert.run(runId, operation.operationId, operation.attempt, operation.kind, operation.status,
        operation.idempotencyKey, operation.sideEffect ? 1 : 0, operation.requiresHumanConfirmation ? 1 : 0,
        'null', operation.inputDigest ?? null, operation.providerOperationId ?? null,
        operation.resultRef ?? null, operation.preparedAt, operation.updatedAt);
    }
  }

  private replaceChildren(runId: string, children: ChildRunRef[]): void {
    this.db.prepare('DELETE FROM durable_run_children WHERE parent_run_id = ?').run(runId);
    const insert = this.db.prepare(`INSERT INTO durable_run_children
      (parent_run_id, child_run_id, relation, status, created_at, terminal_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const child of children) {
      insert.run(runId, child.childRunId, child.relation, child.status, child.createdAt, child.terminalAt ?? null);
    }
  }
}
