import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionDelegationsSchema } from '../../../src/host/services/core/database/schemaSessionDelegations';
import {
  SessionDelegationRepository,
  type InsertSessionDelegationInput,
  type InsertSessionDelegationResult,
  type SessionDelegationAbortReason,
  type SessionDelegationDisposition,
  type SessionDelegationRecord,
  type SessionDelegationStatus,
} from '../../../src/host/services/core/repositories/SessionDelegationRepository';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

const COLUMNS: Array<{ name: string; notnull: number; pk: number }> = [
  { name: 'delegation_id', notnull: 1, pk: 1 },
  { name: 'origin_session_id', notnull: 1, pk: 0 },
  { name: 'origin_turn_id', notnull: 1, pk: 0 },
  { name: 'disposition', notnull: 1, pk: 0 },
  { name: 'target_session_id', notnull: 1, pk: 0 },
  { name: 'target_message_id', notnull: 0, pk: 0 },
  { name: 'target_queued_input_id', notnull: 0, pk: 0 },
  { name: 'target_run_id', notnull: 0, pk: 0 },
  { name: 'submission_key', notnull: 1, pk: 0 },
  { name: 'action_fingerprint', notnull: 1, pk: 0 },
  { name: 'status', notnull: 1, pk: 0 },
  { name: 'supersedes_delegation_id', notnull: 0, pk: 0 },
  { name: 'created_at', notnull: 1, pk: 0 },
  { name: 'resolved_at', notnull: 0, pk: 0 },
  { name: 'resolution_json', notnull: 0, pk: 0 },
];

const NAMED_INDEXES = [
  'idx_session_delegations_origin_turn',
  'idx_session_delegations_target_queued_input',
  'idx_session_delegations_target_run',
  'idx_session_delegations_target_status',
];

type RawRow = Record<string, unknown>;

function tableInfo(db: BetterSqlite3.Database): Array<{ name: string; notnull: number; pk: number }> {
  return (db.prepare('PRAGMA table_info(session_delegations)').all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>).map((column) => ({ name: column.name, notnull: column.notnull, pk: column.pk }));
}

function namedIndexNames(db: BetterSqlite3.Database): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'index' AND tbl_name = 'session_delegations' AND sql IS NOT NULL
     ORDER BY name`,
  ).all() as Array<{ name: string }>).map((index) => index.name);
}

function indexColumns(db: BetterSqlite3.Database, indexName: string): string[] {
  return (db.prepare(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string }>).map((column) => column.name);
}

function delegationMaster(db: BetterSqlite3.Database): RawRow[] {
  return db.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'session_delegations' OR name = 'session_delegations'
     ORDER BY type, name`,
  ).all() as RawRow[];
}

function rawInsert(
  db: BetterSqlite3.Database,
  overrides: Record<string, string | number | null> = {},
): void {
  const row: Record<string, string | number | null> = {
    delegation_id: 'd1',
    origin_session_id: 'origin',
    origin_turn_id: 'turn',
    disposition: 'delegate_existing',
    target_session_id: 'target',
    target_message_id: null,
    target_queued_input_id: null,
    target_run_id: null,
    submission_key: 'sub',
    action_fingerprint: 'fp',
    status: 'active',
    supersedes_delegation_id: null,
    created_at: 1,
    resolved_at: null,
    resolution_json: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO session_delegations (
      delegation_id, origin_session_id, origin_turn_id, disposition,
      target_session_id, target_message_id, target_queued_input_id, target_run_id,
      submission_key, action_fingerprint, status, supersedes_delegation_id,
      created_at, resolved_at, resolution_json
    ) VALUES (
      @delegation_id, @origin_session_id, @origin_turn_id, @disposition,
      @target_session_id, @target_message_id, @target_queued_input_id, @target_run_id,
      @submission_key, @action_fingerprint, @status, @supersedes_delegation_id,
      @created_at, @resolved_at, @resolution_json
    )`,
  ).run(row);
}

describe('session_delegations schema', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the ADR D5 columns, CHECKs, UNIQUE submission_key, and four indexes', () => {
    applySchema(db, logger);

    expect(tableInfo(db)).toEqual(COLUMNS);
    const tableSql = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_delegations'`,
    ).get() as { sql: string }).sql;
    expect(tableSql).toContain("CHECK (status IN ('active','superseded','stopped','aborted','terminal_observed'))");
    expect(tableSql).toContain("CHECK (disposition IN ('delegate_existing','create_new'))");
    expect(tableSql).toContain('submission_key TEXT NOT NULL UNIQUE');
    expect(namedIndexNames(db)).toEqual(NAMED_INDEXES);
    expect(indexColumns(db, 'idx_session_delegations_target_status')).toEqual(['target_session_id', 'status']);
    expect(indexColumns(db, 'idx_session_delegations_target_queued_input')).toEqual(['target_queued_input_id']);
    expect(indexColumns(db, 'idx_session_delegations_target_run')).toEqual(['target_run_id']);
    expect(indexColumns(db, 'idx_session_delegations_origin_turn')).toEqual(['origin_session_id', 'origin_turn_id']);

    const uniqueOnSubmissionKey = (db.prepare('PRAGMA index_list(session_delegations)').all() as Array<{
      name: string;
      unique: number;
    }>).filter((index) => index.unique === 1 && indexColumns(db, index.name).join(',') === 'submission_key');
    expect(uniqueOnSubmissionKey).toHaveLength(1);
  });

  it('is idempotent and does not touch other tables', () => {
    db.exec(`
      CREATE TABLE queued_inputs (id TEXT PRIMARY KEY, note TEXT);
      CREATE TABLE decoy (id TEXT PRIMARY KEY, note TEXT);
      INSERT INTO queued_inputs (id, note) VALUES ('q-keep', 'keep');
      INSERT INTO decoy (id, note) VALUES ('d-keep', 'keep');
    `);
    const otherMaster = (): RawRow[] => db.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE '%session_delegations%' AND IFNULL(tbl_name, '') != 'session_delegations'
       ORDER BY type, name`,
    ).all() as RawRow[];
    applySessionDelegationsSchema(db, logger);
    const beforeMaster = otherMaster();
    const queuedBefore = db.prepare('SELECT * FROM queued_inputs').all();
    const decoyBefore = db.prepare('SELECT * FROM decoy').all();
    const delegationBefore = delegationMaster(db);

    applySessionDelegationsSchema(db, logger);

    expect(otherMaster()).toEqual(beforeMaster);
    expect(db.prepare('SELECT * FROM queued_inputs').all()).toEqual(queuedBefore);
    expect(db.prepare('SELECT * FROM decoy').all()).toEqual(decoyBefore);
    expect(delegationMaster(db)).toEqual(delegationBefore);
    expect(tableInfo(db)).toEqual(COLUMNS);
  });

  it('second applySchema is a no-op and keeps existing queued_inputs rows', () => {
    applySchema(db, logger);
    db.prepare(
      `INSERT INTO queued_inputs (
        id, session_id, envelope_json, status, retry_count, position,
        paused_reason, created_at, updated_at
      ) VALUES ('queued-keep', 'session-keep', '{"content":"keep"}', 'queued', 2, 4, 'restart', 11, 12)`,
    ).run();
    const queuedBefore = db.prepare('SELECT * FROM queued_inputs').all();
    const delegationBefore = delegationMaster(db);
    const queuedMasterBefore = db.prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE tbl_name = 'queued_inputs' OR name = 'queued_inputs'
       ORDER BY type, name`,
    ).all();

    applySchema(db, logger);

    expect(db.prepare('SELECT * FROM queued_inputs').all()).toEqual(queuedBefore);
    expect(delegationMaster(db)).toEqual(delegationBefore);
    expect(db.prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE tbl_name = 'queued_inputs' OR name = 'queued_inputs'
       ORDER BY type, name`,
    ).all()).toEqual(queuedMasterBefore);
  });

  it('recreates session_delegations on a database that already has queued_inputs rows', () => {
    applySchema(db, logger);
    db.exec('DROP TABLE session_delegations');
    db.prepare(
      `INSERT INTO queued_inputs (
        id, session_id, envelope_json, status, retry_count, position,
        paused_reason, created_at, updated_at
      ) VALUES ('queued-keep', 'session-keep', '{"content":"keep"}', 'failed', 1, 0, 'send_failed', 8, 9)`,
    ).run();
    const queuedBefore = db.prepare('SELECT * FROM queued_inputs').all();

    applySchema(db, logger);

    expect(tableInfo(db)).toEqual(COLUMNS);
    expect(namedIndexNames(db)).toEqual(NAMED_INDEXES);
    expect(db.prepare('SELECT * FROM queued_inputs').all()).toEqual(queuedBefore);
  });

  it('CHECK rejects an unknown status, including run statuses, and an unknown disposition', () => {
    applySchema(db, logger);
    for (const status of ['completed', 'failed', 'cancelled', 'running', 'waiting', 'nope']) {
      expect(() => rawInsert(db, { delegation_id: `bad-${status}`, submission_key: `bad-${status}`, status })).toThrow(/CHECK constraint failed/);
    }
    expect(() => rawInsert(db, { delegation_id: 'bad-disposition', submission_key: 'bad-disposition', disposition: 'steer' })).toThrow(/CHECK constraint failed/);
    rawInsert(db, { delegation_id: 'ok-existing', submission_key: 'ok-existing', disposition: 'delegate_existing', status: 'active' });
    rawInsert(db, { delegation_id: 'ok-new', submission_key: 'ok-new', disposition: 'create_new', status: 'stopped' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_delegations').get()).toEqual({ n: 2 });
  });

  it('UNIQUE rejects a duplicate submission_key via raw INSERT', () => {
    applySchema(db, logger);
    rawInsert(db, { delegation_id: 'd1', submission_key: 'same-key' });
    expect(() => rawInsert(db, { delegation_id: 'd2', submission_key: 'same-key' })).toThrow(/UNIQUE constraint failed: session_delegations\.submission_key/);
    expect(db.prepare('SELECT delegation_id FROM session_delegations').all()).toEqual([{ delegation_id: 'd1' }]);
  });
});

describe('SessionDelegationRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionDelegationRepository;
  let sequence = 0;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger);
    repo = new SessionDelegationRepository(db);
    sequence = 0;
  });

  afterEach(() => {
    db.close();
  });

  function build(overrides: Partial<InsertSessionDelegationInput> = {}): InsertSessionDelegationInput {
    sequence += 1;
    return {
      delegationId: `del-${sequence}`,
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      disposition: 'delegate_existing',
      targetSessionId: 'target-1',
      targetMessageId: `msg-${sequence}`,
      targetQueuedInputId: `queued-${sequence}`,
      submissionKey: `sub-${sequence}`,
      actionFingerprint: 'fp-same',
      createdAt: 1000 + sequence,
      ...overrides,
    };
  }

  function insert(overrides: Partial<InsertSessionDelegationInput> = {}): InsertSessionDelegationResult {
    return repo.insertOrGet(build(overrides));
  }

  function create(overrides: Partial<InsertSessionDelegationInput> = {}): SessionDelegationRecord {
    const result = insert(overrides);
    if (result.kind !== 'created') {
      throw new Error(`expected created, got ${result.kind}`);
    }
    return result.record;
  }

  function raw(delegationId: string): RawRow {
    const row = db.prepare('SELECT * FROM session_delegations WHERE delegation_id = ?').get(delegationId) as RawRow | undefined;
    expect(row).toBeTruthy();
    return row as RawRow;
  }

  function expectRejected(delegationId: string, run: () => number): void {
    const before = raw(delegationId);
    expect(run()).toBe(0);
    expect(raw(delegationId)).toEqual(before);
  }

  function expectUntouched(before: RawRow, after: RawRow, changed: ReadonlySet<string>): void {
    for (const key of Object.keys(before)) {
      if (changed.has(key)) continue;
      expect(after[key], key).toEqual(before[key]);
    }
  }

  function expectStuck(delegationId: string): void {
    const before = raw(delegationId);
    expect(repo.backfillTargetRunId(delegationId, 'run-x')).toBe(0);
    expect(repo.markTerminalObserved(delegationId, 900)).toBe(0);
    expect(repo.markStopped(delegationId, { outcome: 'stop_delivered' }, 900)).toBe(0);
    expect(repo.markResumed(delegationId, 900)).toBe(0);
    expect(repo.markSuperseded(delegationId, 900)).toBe(0);
    expect(repo.markAborted(delegationId, 'delivery_failed', 900)).toBe(0);
    expect(repo.markAborted(delegationId, 'retracted_by_user', 900)).toBe(0);
    expect(repo.reviveAfterResend(delegationId, 'run-new', 900)).toBe(0);
    expect(raw(delegationId)).toEqual(before);
  }

  it('insertOrGet creates an active row and stores the optional supersedes link', () => {
    const disposition: SessionDelegationDisposition = 'create_new';
    const input = build({
      delegationId: 'del-created',
      submissionKey: 'sub-created',
      disposition,
      supersedesDelegationId: 'old-del',
      targetMessageId: 'msg-soft',
      targetQueuedInputId: 'queued-soft',
      createdAt: 42,
    });
    const result = repo.insertOrGet(input);

    expect(result).toEqual({
      kind: 'created',
      record: {
        delegationId: 'del-created',
        originSessionId: 'origin-1',
        originTurnId: 'turn-1',
        disposition: 'create_new',
        targetSessionId: 'target-1',
        targetMessageId: 'msg-soft',
        targetQueuedInputId: 'queued-soft',
        targetRunId: null,
        submissionKey: 'sub-created',
        actionFingerprint: 'fp-same',
        status: 'active',
        supersedesDelegationId: 'old-del',
        createdAt: 42,
        resolvedAt: null,
        resolutionJson: null,
      },
    });
  });

  it('insertOrGet reuses the same submission key and fingerprint without writing', () => {
    const first = create({ actionFingerprint: 'fp-a', createdAt: 10, supersedesDelegationId: 'old' });
    const before = raw(first.delegationId);
    const again = insert({
      delegationId: 'different-id',
      submissionKey: first.submissionKey,
      actionFingerprint: 'fp-a',
      originSessionId: 'other-origin',
      originTurnId: 'other-turn',
      targetSessionId: 'other-target',
      targetMessageId: 'other-msg',
      targetQueuedInputId: 'other-queued',
      createdAt: 99,
      supersedesDelegationId: 'new-old',
      disposition: 'create_new',
    });

    expect(again).toEqual({ kind: 'reused', record: first });
    expect(raw(first.delegationId)).toEqual(before);
    expect(repo.get('different-id')).toBeNull();
  });

  it('insertOrGet reports idempotency_conflict and writes nothing when the fingerprint differs', () => {
    const first = create({ actionFingerprint: 'fp-a', createdAt: 10 });
    const before = raw(first.delegationId);
    const conflict = insert({
      delegationId: 'other-id',
      submissionKey: first.submissionKey,
      actionFingerprint: 'fp-b',
      originSessionId: 'other-origin',
      createdAt: 99,
    });

    expect(conflict).toEqual({ kind: 'idempotency_conflict', record: first });
    expect(raw(first.delegationId)).toEqual(before);
    expect(repo.get('other-id')).toBeNull();
    expect(repo.getBySubmissionKey(first.submissionKey)?.actionFingerprint).toBe('fp-a');
  });

  it('does not treat a primary-key collision as submission-key idempotency', () => {
    create({ delegationId: 'same-id', submissionKey: 'key-1' });
    expect(() => create({ delegationId: 'same-id', submissionKey: 'key-2' })).toThrow(/constraint/i);
    expect(repo.getBySubmissionKey('key-2')).toBeNull();
    expect(repo.get('same-id')?.submissionKey).toBe('key-1');
  });

  it('joins an outer transaction and does not commit on its own', () => {
    const input = build();
    expect(() => {
      db.transaction(() => {
        expect(repo.insertOrGet(input).kind).toBe('created');
        expect(repo.markStopped(input.delegationId, { outcome: 'stop_delivered' }, 5)).toBe(1);
        expect(repo.get(input.delegationId)?.status).toBe('stopped');
        throw new Error('rollback');
      })();
    }).toThrow('rollback');
    expect(repo.get(input.delegationId)).toBeNull();

    db.transaction(() => {
      expect(repo.insertOrGet(input).kind).toBe('created');
    })();
    expect(repo.get(input.delegationId)?.status).toBe('active');
  });

  it('reads by id, submission key, and queued input id', () => {
    const row = create({ targetQueuedInputId: 'queued-one' });
    expect(repo.get(row.delegationId)).toEqual(row);
    expect(repo.getBySubmissionKey(row.submissionKey)).toEqual(row);
    expect(repo.getByTargetQueuedInputId('queued-one')).toEqual(row);
    expect(repo.get('missing')).toBeNull();
    expect(repo.getBySubmissionKey('missing')).toBeNull();
    expect(repo.getByTargetQueuedInputId('missing')).toBeNull();

    create({
      delegationId: 'later-share',
      submissionKey: 'later-share',
      createdAt: 50,
      targetQueuedInputId: 'shared-queued',
    });
    create({
      delegationId: 'earlier-share',
      submissionKey: 'earlier-share',
      createdAt: 40,
      targetQueuedInputId: 'shared-queued',
    });
    expect(repo.getByTargetQueuedInputId('shared-queued')?.delegationId).toBe('earlier-share');
  });

  it('lists an origin turn by creation order', () => {
    const later = create({ originTurnId: 'turn-a', createdAt: 30, delegationId: 'origin-later' });
    const earlier = create({ originTurnId: 'turn-a', createdAt: 20, delegationId: 'origin-earlier' });
    create({ originSessionId: 'origin-2', originTurnId: 'turn-a', createdAt: 10, delegationId: 'other-origin' });
    create({ originTurnId: 'turn-b', createdAt: 15, delegationId: 'other-turn' });

    expect(repo.listByOriginTurn('origin-1', 'turn-a').map((row) => row.delegationId)).toEqual([
      earlier.delegationId,
      later.delegationId,
    ]);
    expect(repo.listByOriginTurn('origin-2', 'turn-a').map((row) => row.delegationId)).toEqual(['other-origin']);
    expect(repo.listByOriginTurn('origin-1', 'turn-b').map((row) => row.delegationId)).toEqual(['other-turn']);
    expect(repo.listByOriginTurn('origin-1', 'missing')).toEqual([]);
  });

  it('stores several active rows on one target and lists them by creation order', () => {
    create({ delegationId: 'm-later', submissionKey: 'k-later', createdAt: 300, targetQueuedInputId: 'q-later' });
    create({ delegationId: 'm-b', submissionKey: 'k-b', createdAt: 100, targetQueuedInputId: 'q-b' });
    create({ delegationId: 'm-a', submissionKey: 'k-a', createdAt: 100, targetQueuedInputId: 'q-a' });
    create({
      delegationId: 'm-other',
      submissionKey: 'k-other',
      createdAt: 50,
      targetSessionId: 'target-2',
      targetQueuedInputId: 'q-other',
    });

    expect(repo.listByTargetSession('target-1').map((row) => row.status)).toEqual(['active', 'active', 'active']);
    expect(repo.listByTargetSession('target-1').map((row) => row.delegationId)).toEqual(['m-a', 'm-b', 'm-later']);
    expect(repo.listByTargetSession('target-2').map((row) => row.delegationId)).toEqual(['m-other']);

    expect(repo.markStopped('m-b', { outcome: 'stop_delivered' }, 9)).toBe(1);
    const stoppedOnly: readonly SessionDelegationStatus[] = ['stopped'];
    expect(repo.listByTargetSession('target-1', stoppedOnly).map((row) => row.delegationId)).toEqual(['m-b']);
    expect(repo.listByTargetSession('target-1', ['active']).map((row) => row.delegationId)).toEqual(['m-a', 'm-later']);
    expect(repo.listByTargetSession('target-1', [])).toEqual([]);
  });

  it('backfillTargetRunId sets target_run_id once and never overwrites (INV-4)', () => {
    const row = create();
    const before = raw(row.delegationId);
    expect(repo.backfillTargetRunId(row.delegationId, 'run-1')).toBe(1);
    const once = raw(row.delegationId);
    expect(once.target_run_id).toBe('run-1');
    expectUntouched(before, once, new Set(['target_run_id']));
    expectRejected(row.delegationId, () => repo.backfillTargetRunId(row.delegationId, 'run-2'));
    expectRejected(row.delegationId, () => repo.backfillTargetRunId(row.delegationId, 'run-1'));
    expect(repo.get(row.delegationId)?.targetRunId).toBe('run-1');
  });

  it('backfillTargetRunId rejects every status other than active', () => {
    const stopped = create();
    expect(repo.markStopped(stopped.delegationId, { outcome: 'stop_delivered' }, 4)).toBe(1);
    expectRejected(stopped.delegationId, () => repo.backfillTargetRunId(stopped.delegationId, 'run'));

    const aborted = create();
    expect(repo.markAborted(aborted.delegationId, 'delivery_failed', 4)).toBe(1);
    expectRejected(aborted.delegationId, () => repo.backfillTargetRunId(aborted.delegationId, 'run'));

    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 4)).toBe(1);
    expectRejected(superseded.delegationId, () => repo.backfillTargetRunId(superseded.delegationId, 'run'));

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 4)).toBe(1);
    expectRejected(observed.delegationId, () => repo.backfillTargetRunId(observed.delegationId, 'run'));
    expect(repo.backfillTargetRunId('missing', 'run')).toBe(0);
  });

  it('markTerminalObserved records active and stopped, and is idempotent', () => {
    const active = create();
    const activeBefore = raw(active.delegationId);
    expect(repo.markTerminalObserved(active.delegationId, 41)).toBe(1);
    const activeAfter = raw(active.delegationId);
    expect(activeAfter.status).toBe('terminal_observed');
    expect(activeAfter.resolved_at).toBe(41);
    expectUntouched(activeBefore, activeAfter, new Set(['status', 'resolved_at']));
    expectRejected(active.delegationId, () => repo.markTerminalObserved(active.delegationId, 99));
    expect(repo.get(active.delegationId)?.resolvedAt).toBe(41);

    const stopped = create();
    expect(repo.markStopped(stopped.delegationId, { outcome: 'stop_delivered' }, 40)).toBe(1);
    const stoppedBefore = raw(stopped.delegationId);
    expect(repo.markTerminalObserved(stopped.delegationId, 50)).toBe(1);
    const stoppedAfter = raw(stopped.delegationId);
    expect(stoppedAfter.status).toBe('terminal_observed');
    expect(stoppedAfter.resolved_at).toBe(50);
    expect(stoppedAfter.resolution_json).toBe(JSON.stringify({ outcome: 'stop_delivered' }));
    expectUntouched(stoppedBefore, stoppedAfter, new Set(['status', 'resolved_at']));
    expectRejected(stopped.delegationId, () => repo.markTerminalObserved(stopped.delegationId, 80));
  });

  it('markTerminalObserved rejects aborted and superseded', () => {
    const aborted = create();
    expect(repo.markAborted(aborted.delegationId, 'delivery_failed', 5)).toBe(1);
    expectRejected(aborted.delegationId, () => repo.markTerminalObserved(aborted.delegationId, 6));

    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 5)).toBe(1);
    expectRejected(superseded.delegationId, () => repo.markTerminalObserved(superseded.delegationId, 6));
  });

  it('markStopped moves only active rows and keeps a repeated call unchanged', () => {
    const row = create();
    expect(repo.backfillTargetRunId(row.delegationId, 'run-1')).toBe(1);
    const before = raw(row.delegationId);
    expect(repo.markStopped(row.delegationId, { outcome: 'stop_delivered' }, 18)).toBe(1);
    const after = raw(row.delegationId);
    expect(after.status).toBe('stopped');
    expect(after.resolved_at).toBe(18);
    expect(after.resolution_json).toBe(JSON.stringify({ outcome: 'stop_delivered' }));
    expect(after.target_run_id).toBe('run-1');
    expectUntouched(before, after, new Set(['status', 'resolved_at', 'resolution_json']));
    expectRejected(row.delegationId, () => repo.markStopped(row.delegationId, { outcome: 'again' }, 19));

    const aborted: SessionDelegationAbortReason = 'delivery_failed';
    const abortedRow = create();
    expect(repo.markAborted(abortedRow.delegationId, aborted, 7)).toBe(1);
    expectRejected(abortedRow.delegationId, () => repo.markStopped(abortedRow.delegationId, { outcome: 'no' }, 8));

    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 7)).toBe(1);
    expectRejected(superseded.delegationId, () => repo.markStopped(superseded.delegationId, { outcome: 'no' }, 8));

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 7)).toBe(1);
    expectRejected(observed.delegationId, () => repo.markStopped(observed.delegationId, { outcome: 'no' }, 8));
  });

  it('markStopped writes nothing when the resolution cannot be encoded', () => {
    const row = create();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectRejected(row.delegationId, () => repo.markStopped(row.delegationId, circular, 3));
    expectRejected(row.delegationId, () => repo.markStopped(row.delegationId, undefined, 3));
  });

  it('markResumed moves only stopped rows back to active', () => {
    const row = create();
    expect(repo.backfillTargetRunId(row.delegationId, 'run-1')).toBe(1);
    expect(repo.markStopped(row.delegationId, { outcome: 'stop_delivered' }, 18)).toBe(1);
    const before = raw(row.delegationId);
    expect(repo.markResumed(row.delegationId, 21)).toBe(1);
    const after = raw(row.delegationId);
    expect(after.status).toBe('active');
    expect(after.resolved_at).toBeNull();
    expect(after.resolution_json).toBeNull();
    expect(after.target_run_id).toBe('run-1');
    expectUntouched(before, after, new Set(['status', 'resolved_at', 'resolution_json']));
    expectRejected(row.delegationId, () => repo.markResumed(row.delegationId, 22));

    const aborted = create();
    expect(repo.markAborted(aborted.delegationId, 'delivery_failed', 4)).toBe(1);
    expectRejected(aborted.delegationId, () => repo.markResumed(aborted.delegationId, 5));

    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 4)).toBe(1);
    expectRejected(superseded.delegationId, () => repo.markResumed(superseded.delegationId, 5));

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 4)).toBe(1);
    expectRejected(observed.delegationId, () => repo.markResumed(observed.delegationId, 5));
  });

  it('markSuperseded moves only active rows and is terminal', () => {
    const row = create();
    const before = raw(row.delegationId);
    expect(repo.markSuperseded(row.delegationId, 33)).toBe(1);
    const after = raw(row.delegationId);
    expect(after.status).toBe('superseded');
    expect(after.resolved_at).toBe(33);
    expectUntouched(before, after, new Set(['status', 'resolved_at']));
    expectRejected(row.delegationId, () => repo.markSuperseded(row.delegationId, 34));

    const stopped = create();
    expect(repo.markStopped(stopped.delegationId, { outcome: 'stop_delivered' }, 4)).toBe(1);
    expectRejected(stopped.delegationId, () => repo.markSuperseded(stopped.delegationId, 5));

    const aborted = create();
    expect(repo.markAborted(aborted.delegationId, 'retracted_by_user', 4)).toBe(1);
    expectRejected(aborted.delegationId, () => repo.markSuperseded(aborted.delegationId, 5));

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 4)).toBe(1);
    expectRejected(observed.delegationId, () => repo.markSuperseded(observed.delegationId, 5));
  });

  it('markAborted stores the reason from active', () => {
    for (const reason of ['delivery_failed', 'retracted_by_user'] as const) {
      const row = create();
      const before = raw(row.delegationId);
      expect(repo.markAborted(row.delegationId, reason, 15)).toBe(1);
      const after = raw(row.delegationId);
      expect(after.status).toBe('aborted');
      expect(after.resolved_at).toBe(15);
      expect(after.resolution_json).toBe(JSON.stringify({ reason }));
      expectUntouched(before, after, new Set(['status', 'resolved_at', 'resolution_json']));
    }
  });

  it('markAborted allows delivery_failed to become retracted_by_user and never the reverse', () => {
    const row = create();
    expect(repo.backfillTargetRunId(row.delegationId, 'run-1')).toBe(1);
    expect(repo.markAborted(row.delegationId, 'delivery_failed', 10)).toBe(1);
    expectRejected(row.delegationId, () => repo.markAborted(row.delegationId, 'delivery_failed', 11));
    const before = raw(row.delegationId);
    expect(repo.markAborted(row.delegationId, 'retracted_by_user', 12)).toBe(1);
    const after = raw(row.delegationId);
    expect(after.status).toBe('aborted');
    expect(after.resolved_at).toBe(12);
    expect(after.resolution_json).toBe(JSON.stringify({ reason: 'retracted_by_user' }));
    expect(after.target_run_id).toBe('run-1');
    expectUntouched(before, after, new Set(['resolved_at', 'resolution_json']));
    expectRejected(row.delegationId, () => repo.markAborted(row.delegationId, 'delivery_failed', 13));
    expectRejected(row.delegationId, () => repo.markAborted(row.delegationId, 'retracted_by_user', 14));
  });

  it('markAborted rejects stopped, superseded, and terminal_observed', () => {
    const stopped = create();
    expect(repo.markStopped(stopped.delegationId, { outcome: 'stop_delivered' }, 4)).toBe(1);
    expectRejected(stopped.delegationId, () => repo.markAborted(stopped.delegationId, 'retracted_by_user', 5));

    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 4)).toBe(1);
    expectRejected(superseded.delegationId, () => repo.markAborted(superseded.delegationId, 'delivery_failed', 5));

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 4)).toBe(1);
    expectRejected(observed.delegationId, () => repo.markAborted(observed.delegationId, 'delivery_failed', 5));
  });

  it('reviveAfterResend revives only aborted(delivery_failed) (INV-6)', () => {
    const failed = create();
    expect(repo.backfillTargetRunId(failed.delegationId, 'run-old')).toBe(1);
    expect(repo.markAborted(failed.delegationId, 'delivery_failed', 20)).toBe(1);
    const before = raw(failed.delegationId);
    expect(repo.reviveAfterResend(failed.delegationId, 'run-new', 30)).toBe(1);
    const revived = raw(failed.delegationId);
    expect(revived.status).toBe('active');
    expect(revived.target_run_id).toBe('run-new');
    expect(revived.resolved_at).toBeNull();
    expect(revived.resolution_json).toBeNull();
    expectUntouched(before, revived, new Set(['status', 'target_run_id', 'resolved_at', 'resolution_json']));
    expectRejected(failed.delegationId, () => repo.reviveAfterResend(failed.delegationId, 'run-third', 40));

    const retracted = create();
    expect(repo.backfillTargetRunId(retracted.delegationId, 'run-retracted')).toBe(1);
    expect(repo.markAborted(retracted.delegationId, 'retracted_by_user', 21)).toBe(1);
    expectRejected(retracted.delegationId, () => repo.reviveAfterResend(retracted.delegationId, 'run-new', 31));

    const active = create();
    expectRejected(active.delegationId, () => repo.reviveAfterResend(active.delegationId, 'run-new', 31));

    const stopped = create();
    expect(repo.markStopped(stopped.delegationId, { outcome: 'stop_delivered' }, 22)).toBe(1);
    expectRejected(stopped.delegationId, () => repo.reviveAfterResend(stopped.delegationId, 'run-new', 31));

    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 22)).toBe(1);
    expectRejected(superseded.delegationId, () => repo.reviveAfterResend(superseded.delegationId, 'run-new', 31));

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 22)).toBe(1);
    expectRejected(observed.delegationId, () => repo.reviveAfterResend(observed.delegationId, 'run-new', 31));
  });

  it('superseded and terminal_observed never leave their state', () => {
    const superseded = create();
    expect(repo.markSuperseded(superseded.delegationId, 10)).toBe(1);
    expectStuck(superseded.delegationId);

    const observed = create();
    expect(repo.markTerminalObserved(observed.delegationId, 11)).toBe(1);
    expectStuck(observed.delegationId);
    expect(repo.get(observed.delegationId)?.resolvedAt).toBe(11);
    expect(repo.get(superseded.delegationId)?.status).toBe('superseded');
    expect(repo.get(observed.delegationId)?.status).toBe('terminal_observed');
  });

  it('rejects a non-finite clock without writing', () => {
    const row = create();
    const before = raw(row.delegationId);
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(repo.markTerminalObserved(row.delegationId, now)).toBe(0);
      expect(repo.markStopped(row.delegationId, { outcome: 'x' }, now)).toBe(0);
      expect(repo.markResumed(row.delegationId, now)).toBe(0);
      expect(repo.markSuperseded(row.delegationId, now)).toBe(0);
      expect(repo.markAborted(row.delegationId, 'delivery_failed', now)).toBe(0);
      expect(repo.reviveAfterResend(row.delegationId, 'run', now)).toBe(0);
    }
    expect(raw(row.delegationId)).toEqual(before);
    expect(repo.markTerminalObserved('missing', 1)).toBe(0);
    expect(repo.markStopped('missing', { outcome: 'x' }, 1)).toBe(0);
    expect(repo.markResumed('missing', 1)).toBe(0);
    expect(repo.markSuperseded('missing', 1)).toBe(0);
    expect(repo.markAborted('missing', 'delivery_failed', 1)).toBe(0);
    expect(repo.reviveAfterResend('missing', 'run', 1)).toBe(0);
  });
});
