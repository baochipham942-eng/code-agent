// ============================================================================
// SessionRewindRepository — direct unit tests (N-TEST-BACKFILL-T01)
// ============================================================================
// tests/unit/repositories/SessionRewindRepository.test.ts exercises rewind
// through the SessionRepository facade. This file imports the extracted
// repository directly so its own branches (idempotency conflicts, audit
// parsing, owner boundary, generative-UI side effects, ledger wiring,
// legacy schema fallback) are pinned at the module level.
//
// 夹具走生产 applyTestSessionSchema（messagesSchemaFixtureGate 要求），
// 台账协作对象用真实 ConversationBranchRepository，不手写假对象。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';
import type { ConversationMessageSnapshot } from '../../../src/shared/contract/conversationBranch';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionRewindRepository } from '../../../src/host/services/core/repositories/SessionRewindRepository';

type SQLiteRow = Record<string, unknown>;

/** Derived from the contract so the ledger append path stays type-checked. */
type MessageRole = ConversationMessageSnapshot['role'];

const OWNER = 'owner-1';

interface Rig {
  db: BetterSqlite3.Database;
  repo: SessionRewindRepository;
  ledger: ConversationBranchRepository;
}

function createRig(): Rig {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyTestSessionSchema(db);
  applyConversationBranchSchema(db);
  const ledger = new ConversationBranchRepository(db);
  // Default rig mirrors the legacy-DB configuration (no conversation_branches
  // table → SessionRepository passes null); ledger-wired tests build their own
  // repository over `ledger` after seeding it.
  return { db, repo: new SessionRewindRepository(db, null), ledger };
}

function createLedgerWiredRepo(rig: Rig): SessionRewindRepository {
  return new SessionRewindRepository(rig.db, rig.ledger);
}

function seedSession(
  db: BetterSqlite3.Database,
  id: string,
  opts: { userId?: string | null; projectId?: string | null; status?: string } = {},
): void {
  db.prepare(`
    INSERT INTO sessions (id, user_id, project_id, title, model_provider, model_name, status, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test', 'test-model', ?, 0, 1, 1)
  `).run(id, opts.userId ?? null, opts.projectId ?? null, `session-${id}`, opts.status ?? 'idle');
}

function seedMessages(
  db: BetterSqlite3.Database,
  sessionId: string,
  rows: ReadonlyArray<readonly [id: string, role: MessageRole, content: string, timestamp: number]>,
): void {
  const insert = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp, is_meta, visibility)
    VALUES (?, ?, ?, ?, ?, 0, 'active')
  `);
  for (const [id, role, content, timestamp] of rows) insert.run(id, sessionId, role, content, timestamp);
}

/** Mirror the SessionRepository double-write: projection row + immutable ledger append. */
function appendToLedger(
  ledger: ConversationBranchRepository,
  sessionId: string,
  boundary: { ownerUserId: string | null; projectId: string | null },
  rows: ReadonlyArray<readonly [id: string, role: MessageRole, content: string, timestamp: number]>,
): void {
  for (const [id, role, content, timestamp] of rows) {
    ledger.appendMessage({
      sessionId,
      boundary,
      message: { id, role, content, timestamp },
      idempotencyKey: `seed-${sessionId}-${id}`,
    });
  }
}

function rewindRow(db: BetterSqlite3.Database, id: string): SQLiteRow {
  return db.prepare('SELECT * FROM session_rewinds WHERE id = ?').get(id) as SQLiteRow;
}

function messageRow(db: BetterSqlite3.Database, id: string): SQLiteRow {
  return db.prepare('SELECT id, visibility, hidden_by_rewind_id, hidden_at, synced_at FROM messages WHERE id = ?').get(id) as SQLiteRow;
}

function totalChanges(db: BetterSqlite3.Database): number {
  return (db.prepare('SELECT total_changes() AS total_changes').get() as { total_changes: number }).total_changes;
}

const BOUNDARY = { ownerUserId: OWNER, projectId: null } as const;

describe('SessionRewindRepository (direct)', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = createRig();
  });

  afterEach(() => rig.db.close());

  // --- applyPromptRewind -----------------------------------------------------

  it('soft-hides only the active suffix after the anchor and writes a completed audit row', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);

    const result = repo.applyPromptRewind('s1', 'u2', {
      ownerUserId: OWNER,
      createdAt: 1_000,
      filesRestored: 2,
      filesDeleted: 1,
      errors: ['ckpt missing'],
    });

    expect(result.rewindId).toMatch(/^rewind_1000_[0-9a-f]{8}$/);
    expect(result.anchorMessage).toMatchObject({ id: 'u2', role: 'user', content: 'two' });
    expect(result.hiddenMessageIds).toEqual(['a2']);
    expect(result.hiddenMessageCount).toBe(1);
    expect(result.activeMessages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);

    const row = rewindRow(db, result.rewindId);
    expect(row).toMatchObject({
      session_id: 's1',
      anchor_message_id: 'u2',
      anchor_prompt: 'two',
      anchor_timestamp: 30,
      hidden_message_count: 1,
      hidden_message_ids: '["a2"]',
      files_restored: 2,
      files_deleted: 1,
      errors_json: '["ckpt missing"]',
      idempotency_key: null,
      status: 'completed',
      restored_at: null,
      created_at: 1_000,
    });
    expect(messageRow(db, 'a2')).toMatchObject({
      visibility: 'rewound',
      hidden_by_rewind_id: result.rewindId,
      hidden_at: 1_000,
      synced_at: null,
    });
    expect(messageRow(db, 'u2')).toMatchObject({ visibility: 'active', hidden_by_rewind_id: null });
    const session = db.prepare('SELECT updated_at, synced_at FROM sessions WHERE id = ?').get('s1') as SQLiteRow;
    expect(session.updated_at).toBe(1_000);
    expect(session.synced_at).toBeNull();
  });

  it('hides same-timestamp messages only when their rowid is after the anchor', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    // m0 shares the anchor timestamp but sits at an earlier rowid: stays active.
    seedMessages(db, 's1', [
      ['m0', 'assistant', 'same ts before anchor', 10],
      ['u1', 'user', 'anchor', 10],
      ['a1', 'assistant', 'same ts after anchor', 10],
      ['a2', 'assistant', 'later ts', 20],
    ]);

    const result = repo.applyPromptRewind('s1', 'u1', { ownerUserId: OWNER, createdAt: 1_000 });

    expect(result.hiddenMessageIds).toEqual(['a1', 'a2']);
    expect(result.activeMessages.map((message) => message.id)).toEqual(['m0', 'u1']);
  });

  it('keeps every message active when the anchor is the last message (empty suffix)', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
    ]);

    const result = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });

    expect(result.hiddenMessageIds).toEqual([]);
    expect(result.hiddenMessageCount).toBe(0);
    expect(result.activeMessages).toHaveLength(3);
    expect(rewindRow(db, result.rewindId).hidden_message_ids).toBe('[]');
  });

  it('rejects a missing, non-user, or rewound anchor with zero writes', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
    ]);
    db.prepare("UPDATE messages SET visibility = 'rewound' WHERE id = 'u1'").run();

    for (const anchor of ['missing', 'a1', 'u1']) {
      const before = totalChanges(db);
      expect(() => repo.applyPromptRewind('s1', anchor, { ownerUserId: OWNER, createdAt: 1_000 }))
        .toThrow(`Active user message not found: ${anchor}`);
      expect(totalChanges(db)).toBe(before);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 0 });
  });

  it('requires an explicit owner boundary and matches it exactly', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [['u1', 'user', 'one', 10]]);

    for (const ownerUserId of [undefined, '   '] as const) {
      expect(() => repo.applyPromptRewind('s1', 'u1', { ownerUserId, createdAt: 1_000 }))
        .toThrow('SESSION_ACCESS_DENIED: an explicit owner boundary is required');
    }
    expect(() => repo.applyPromptRewind('s1', 'u1', { ownerUserId: 'someone-else', createdAt: 1_000 }))
      .toThrow('SESSION_ACCESS_DENIED: session not found or owner mismatch');

    // null owner only matches an anonymous session.
    expect(() => repo.applyPromptRewind('s1', 'u1', { ownerUserId: null, createdAt: 1_000 }))
      .toThrow('SESSION_ACCESS_DENIED: session not found or owner mismatch');
    seedSession(db, 'anon', { userId: null });
    seedMessages(db, 'anon', [['anon-u1', 'user', 'one', 10]]);
    expect(() => repo.applyPromptRewind('anon', 'anon-u1', { ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow('SESSION_ACCESS_DENIED: session not found or owner mismatch');
    const anonymous = repo.applyPromptRewind('anon', 'anon-u1', { ownerUserId: null, createdAt: 1_000 });
    expect(anonymous.anchorMessage.id).toBe('anon-u1');
  });

  it('rejects mutation while the session status is running even with a valid owner', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER, status: 'running' });
    seedMessages(db, 's1', [['u1', 'user', 'one', 10]]);

    expect(() => repo.applyPromptRewind('s1', 'u1', { ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow('SESSION_RUNNING: session is running');
  });

  it('rejects mutation while a durable run is active even when the projection says idle', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [['u1', 'user', 'one', 10]]);
    // Repository only reads run_id/session_id/status; keep the fixture minimal
    // like tests/unit/repositories/SessionRewindRepository.test.ts does.
    db.exec(`
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        status TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO durable_runs (run_id, session_id, parent_run_id, status) VALUES ('run-1', 's1', NULL, 'waiting')").run();

    expect(() => repo.applyPromptRewind('s1', 'u1', { ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow('SESSION_RUNNING: durable run run-1 is waiting');

    db.prepare("UPDATE durable_runs SET status = 'failed' WHERE run_id = 'run-1'").run();
    expect(() => repo.applyPromptRewind('s1', 'u1', { ownerUserId: OWNER, createdAt: 1_000 })).not.toThrow();
  });

  it('replays the same rewind for a repeated idempotency key and trims the key', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);

    const first = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: '  k1  ', ownerUserId: OWNER, createdAt: 1_000 });
    const second = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 2_000 });

    expect(second.rewindId).toBe(first.rewindId);
    expect(second.hiddenMessageIds).toEqual(first.hiddenMessageIds);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 1 });
    expect(rewindRow(db, first.rewindId).idempotency_key).toBe('k1');

    // Without an idempotency key each call writes a new audit row.
    repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 3_000 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 2 });
  });

  it('rejects idempotency reuse for another request, a restored rewind, or a foreign status', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['u3', 'user', 'three', 50],
      ['a2', 'assistant', 'answer two', 40],
      ['a3', 'assistant', 'answer three', 60],
    ]);

    const first = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 });

    expect(() => repo.applyPromptRewind('s1', 'u3', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow('IDEMPOTENCY_CONFLICT: the idempotency key was already used for another rewind');

    repo.restorePromptRewind('s1', first.rewindId, 1_500, OWNER);
    expect(() => repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow('IDEMPOTENCY_CONFLICT: the rewind was already restored; use a new idempotency key');

    const second = repo.applyPromptRewind('s1', 'u3', { idempotencyKey: 'k2', ownerUserId: OWNER, createdAt: 2_000 });
    db.prepare("UPDATE session_rewinds SET status = 'failed' WHERE id = ?").run(second.rewindId);
    expect(() => repo.applyPromptRewind('s1', 'u3', { idempotencyKey: 'k2', ownerUserId: OWNER, createdAt: 2_000 }))
      .toThrow('IDEMPOTENCY_CONFLICT: the existing rewind is failed');
  });

  it('hides active generative UI instances and invalidates their pending manifests', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'with ui', 40],
    ]);
    db.prepare(`
      INSERT INTO generative_ui_instances (
        instance_id, session_id, source_message_id, source_ordinal, source_key,
        spec_hash, spec_json, state_json, state_revision, status, created_at, updated_at
      ) VALUES ('ui-1', 's1', 'a2', 0, 'ui-key-1', 'hash', '{}', '{}', 0, 'active', 5, 5)
    `).run();
    db.prepare(`
      INSERT INTO execution_manifests (
        manifest_id, session_id, instance_id, nonce, scope_hash, title, summary,
        items_json, status, expires_at, created_at, updated_at
      ) VALUES ('mf-1', 's1', 'ui-1', 'n1', 'scope', 't', 's', '[]', 'executing', 99, 5, 5)
    `).run();

    repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });

    expect(db.prepare('SELECT status, hidden_by_rewind_id, updated_at FROM generative_ui_instances WHERE instance_id = ?').get('ui-1'))
      .toEqual({ status: 'hidden', hidden_by_rewind_id: expect.any(String), updated_at: 1_000 });
    expect(db.prepare('SELECT status, resolved_at, invalidation_reason FROM execution_manifests WHERE manifest_id = ?').get('mf-1'))
      .toEqual({ status: 'invalidated', resolved_at: 1_000, invalidation_reason: 'SOURCE_REWOUND' });
  });

  it('skips generative-UI side effects when those tables are absent (legacy DB)', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    db.exec('DROP TABLE execution_manifests');
    db.exec('DROP TABLE generative_ui_instances');

    const result = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });

    expect(result.hiddenMessageIds).toEqual(['a2']);
    expect(messageRow(db, 'a2')).toMatchObject({ visibility: 'rewound', hidden_by_rewind_id: result.rewindId });

    const restored = repo.restorePromptRewind('s1', result.rewindId, 2_000, OWNER);
    expect(restored.restoredMessageCount).toBe(1);
    expect(messageRow(db, 'a2')).toMatchObject({ visibility: 'active', hidden_by_rewind_id: null });
  });

  // --- restorePromptRewind -----------------------------------------------------

  it('restores the hidden suffix, reactivates UI instances, and marks the rewind restored', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'with ui', 40],
    ]);
    db.prepare(`
      INSERT INTO generative_ui_instances (
        instance_id, session_id, source_message_id, source_ordinal, source_key,
        spec_hash, spec_json, state_json, state_revision, status, created_at, updated_at
      ) VALUES ('ui-1', 's1', 'a2', 0, 'ui-key-1', 'hash', '{}', '{}', 0, 'active', 5, 5)
    `).run();

    const rewind = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });
    expect(db.prepare('SELECT status FROM generative_ui_instances WHERE instance_id = ?').get('ui-1'))
      .toEqual({ status: 'hidden' });
    const restored = repo.restorePromptRewind('s1', rewind.rewindId, 2_000, OWNER);

    expect(restored).toMatchObject({ rewindId: rewind.rewindId, restoredMessageCount: 1 });
    expect(restored.activeMessages.map((message) => message.id)).toEqual(['u1', 'u2', 'a2']);
    expect(rewindRow(db, rewind.rewindId)).toMatchObject({ status: 'restored', restored_at: 2_000 });
    expect(messageRow(db, 'a2')).toMatchObject({
      visibility: 'active',
      hidden_by_rewind_id: null,
      hidden_at: null,
      synced_at: null,
    });
    expect(db.prepare('SELECT status, hidden_by_rewind_id, updated_at FROM generative_ui_instances WHERE instance_id = ?').get('ui-1'))
      .toEqual({ status: 'active', hidden_by_rewind_id: null, updated_at: 2_000 });
    const session = db.prepare('SELECT updated_at, synced_at FROM sessions WHERE id = ?').get('s1') as SQLiteRow;
    expect(session.updated_at).toBe(2_000);
    expect(session.synced_at).toBeNull();
  });

  it('is idempotent: restoring an already-restored rewind returns zero without touching rows', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    const rewind = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });
    repo.restorePromptRewind('s1', rewind.rewindId, 2_000, OWNER);
    const before = totalChanges(db);

    const again = repo.restorePromptRewind('s1', rewind.rewindId, 3_000, OWNER);

    expect(again.restoredMessageCount).toBe(0);
    expect(again.activeMessages.map((message) => message.id)).toEqual(['u1', 'u2', 'a2']);
    expect(totalChanges(db)).toBe(before);
    expect(rewindRow(db, rewind.rewindId).restored_at).toBe(2_000);
  });

  it('rejects restoring a missing rewind or one in a foreign status', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    const rewind = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });
    db.prepare("UPDATE session_rewinds SET status = 'failed' WHERE id = ?").run(rewind.rewindId);

    expect(() => repo.restorePromptRewind('s1', 'nope', 2_000, OWNER)).toThrow('Rewind not found: nope');
    expect(() => repo.restorePromptRewind('s1', rewind.rewindId, 2_000, OWNER))
      .toThrow('Rewind cannot be restored from status failed');
  });

  it('restores nested rewinds only in LIFO order', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
      ['u3', 'user', 'three', 50],
      ['a3', 'assistant', 'answer three', 60],
    ]);
    // Rewind the later prompt first, then the earlier one: two stacked rewinds.
    const later = repo.applyPromptRewind('s1', 'u3', { ownerUserId: OWNER, createdAt: 1_000 });
    const earlier = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 2_000 });

    expect(() => repo.restorePromptRewind('s1', later.rewindId, 3_000, OWNER))
      .toThrow(`REWIND_RESTORE_ORDER: restore ${earlier.rewindId} before ${later.rewindId}`);
    expect(repo.restorePromptRewind('s1', earlier.rewindId, 3_000, OWNER).restoredMessageCount).toBe(2);
    expect(repo.restorePromptRewind('s1', later.rewindId, 4_000, OWNER).restoredMessageCount).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 's1' AND visibility = 'active'").get())
      .toEqual({ count: 6 });
  });

  it('defaults restoredAt to the wall clock when the caller omits it', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    const rewind = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });
    const before = Date.now();

    repo.restorePromptRewind('s1', rewind.rewindId, undefined, OWNER);

    const restoredAt = Number(rewindRow(db, rewind.rewindId).restored_at);
    expect(restoredAt).toBeGreaterThanOrEqual(before);
    expect(restoredAt).toBeLessThanOrEqual(Date.now());
  });

  // --- getPromptRewindAudit ------------------------------------------------------

  it('reports the audit row including latest-completed flag and checkpoint ids', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
      ['u3', 'user', 'three', 50],
      ['a3', 'assistant', 'answer three', 60],
    ]);
    // Rewind the later prompt first, then stack the earlier one on top.
    const older = repo.applyPromptRewind('s1', 'u3', { ownerUserId: OWNER, createdAt: 1_000 });
    const newest = repo.applyPromptRewind('s1', 'u2', {
      ownerUserId: OWNER,
      createdAt: 2_000,
      checkpointMessageId: 'ckpt-1',
      redoCheckpointMessageId: 'ckpt-2',
    });

    expect(repo.getPromptRewindAudit('s1', older.rewindId, OWNER)).toEqual({
      rewindId: older.rewindId,
      status: 'completed',
      isLatestCompleted: false,
      checkpointMessageId: null,
      redoCheckpointMessageId: null,
    });
    expect(repo.getPromptRewindAudit('s1', newest.rewindId, OWNER)).toEqual({
      rewindId: newest.rewindId,
      status: 'completed',
      isLatestCompleted: true,
      checkpointMessageId: 'ckpt-1',
      redoCheckpointMessageId: 'ckpt-2',
    });
    expect(() => repo.getPromptRewindAudit('s1', 'nope', OWNER)).toThrow('Rewind not found: nope');
    expect(() => repo.getPromptRewindAudit('s1', newest.rewindId, undefined))
      .toThrow('SESSION_ACCESS_DENIED: an explicit owner boundary is required');

    repo.restorePromptRewind('s1', newest.rewindId, 3_000, OWNER);
    expect(repo.getPromptRewindAudit('s1', newest.rewindId, OWNER)).toMatchObject({
      status: 'restored',
      isLatestCompleted: false,
    });
    expect(repo.getPromptRewindAudit('s1', older.rewindId, OWNER)).toMatchObject({
      status: 'completed',
      isLatestCompleted: true,
    });
  });

  // --- readResult parsing --------------------------------------------------------

  it('replaying an idempotent rewind surfaces corrupt audit JSON as a domain error', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    const rewind = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 });
    db.prepare('UPDATE session_rewinds SET hidden_message_ids = ? WHERE id = ?').run('not-json', rewind.rewindId);

    expect(() => repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow(`Rewind audit is corrupt: ${rewind.rewindId}`);
  });

  it('filters non-string entries from persisted hidden ids while keeping the stored count', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    const rewind = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 });
    db.prepare('UPDATE session_rewinds SET hidden_message_ids = ?, hidden_message_count = 4 WHERE id = ?')
      .run('[1, "a2", null]', rewind.rewindId);

    const replayed = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 });

    expect(replayed.hiddenMessageIds).toEqual(['a2']);
    expect(replayed.hiddenMessageCount).toBe(4);
  });

  it('surfaces a missing anchor when the audit row is replayed after the messages are gone', () => {
    const { db, repo } = rig;
    seedSession(db, 's1', { userId: OWNER });
    seedMessages(db, 's1', [
      ['u1', 'user', 'one', 10],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ]);
    const rewind = repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 });
    db.prepare("DELETE FROM messages WHERE session_id = 's1'").run();

    expect(() => repo.applyPromptRewind('s1', 'u2', { idempotencyKey: 'k1', ownerUserId: OWNER, createdAt: 1_000 }))
      .toThrow(`Rewind anchor is missing: u2`);
    expect(rewindRow(db, rewind.rewindId).status).toBe('completed');
  });

  // --- ledger wiring ----------------------------------------------------------------

  it('records the rewind and its restore in the immutable conversation ledger', () => {
    const { db, ledger } = rig;
    seedSession(db, 's1', { userId: OWNER });
    const rows = [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ] as const;
    seedMessages(db, 's1', rows);
    appendToLedger(ledger, 's1', BOUNDARY, rows);
    const repo = createLedgerWiredRepo(rig);

    const rewind = repo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });

    const eventTypes = () =>
      (db.prepare('SELECT event_type, COUNT(*) AS count FROM conversation_branch_events GROUP BY event_type ORDER BY event_type').all() as Array<{ event_type: string; count: number }>)
        .map((row) => `${row.event_type}:${row.count}`);
    expect(eventTypes()).toEqual(['append:4', 'rewind:1']);
    expect(ledger.replay('s1', BOUNDARY).openRewindIds).toEqual([rewind.rewindId]);

    repo.restorePromptRewind('s1', rewind.rewindId, 2_000, OWNER);

    expect(eventTypes()).toEqual(['append:4', 'rewind:1', 'rewind_restore:1']);
    expect(ledger.replay('s1', BOUNDARY).openRewindIds).toEqual([]);
  });

  it('falls back to NULL AS project_id when the sessions table predates the column', () => {
    const { db, ledger } = rig;
    seedSession(db, 's1', { userId: OWNER, projectId: null });
    const rows = [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ] as const;
    seedMessages(db, 's1', rows);
    appendToLedger(ledger, 's1', BOUNDARY, rows);
    db.exec('DROP INDEX IF EXISTS idx_sessions_project');
    db.exec('ALTER TABLE sessions DROP COLUMN project_id');

    const legacyRepo = new SessionRewindRepository(db, new ConversationBranchRepository(db));
    const result = legacyRepo.applyPromptRewind('s1', 'u2', { ownerUserId: OWNER, createdAt: 1_000 });

    expect(result.hiddenMessageIds).toEqual(['a2']);
    expect(db.prepare('SELECT project_id FROM conversation_branches WHERE session_id = ?').get('s1'))
      .toEqual({ project_id: null });
    expect(result.activeMessages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
  });
});
