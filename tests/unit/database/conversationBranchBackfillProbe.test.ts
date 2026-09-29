// N-BOOT-DB-CHECKS：分支账本遗留回填按需执行。
// 没有待回填的东西时不再逐会话 SELECT * 全部消息；四类待办（缺 branch 的会话、缺 entry 的消息、
// 未落的 fork quarantine、未落的 legacy rewind/restore 事件）任何一类出现都照旧完整回填。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  applyConversationBranchSchema,
  conversationBranchId,
} from '../../../src/host/services/core/database/schemaConversationBranch';

const PER_SESSION_MESSAGE_SCAN = /FROM messages\s+WHERE session_id = \?\s+ORDER BY timestamp ASC, rowid ASC/u;

function createLegacyDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      project_id TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'active',
      hidden_by_rewind_id TEXT,
      hidden_at INTEGER
    );
    CREATE TABLE session_forks (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      child_session_id TEXT NOT NULL UNIQUE,
      root_session_id TEXT NOT NULL,
      parent_fork_id TEXT,
      anchor_message_id TEXT NOT NULL,
      anchor_child_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      depth INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE session_fork_message_map (
      fork_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      source_message_id TEXT NOT NULL,
      child_message_id TEXT NOT NULL,
      PRIMARY KEY (fork_id, ordinal)
    );
    CREATE TABLE session_rewinds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      hidden_message_ids TEXT NOT NULL,
      status TEXT NOT NULL,
      restored_at INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO sessions VALUES ('s1', 'owner-1', 'project-1', 0, 1);
    INSERT INTO sessions VALUES ('s2', 'owner-1', 'project-1', 0, 2);
    INSERT INTO messages VALUES ('s1-u1', 's1', 'user', 'one', 10, NULL, 0, 'active', NULL, NULL);
    INSERT INTO messages VALUES ('s1-a1', 's1', 'assistant', 'two', 20, NULL, 0, 'active', NULL, NULL);
    INSERT INTO messages VALUES ('s2-u1', 's2', 'user', 'three', 30, NULL, 0, 'active', NULL, NULL);
  `);
  return db;
}

function ledgerCounts(db: InstanceType<typeof Database>): Record<string, number> {
  return Object.fromEntries(
    ['conversation_branches', 'conversation_entries', 'conversation_branch_entries', 'conversation_branch_events']
      .map((table) => [table, Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]),
  );
}

function eventKeys(db: InstanceType<typeof Database>, sessionId: string): string[] {
  return (db.prepare(`
    SELECT idempotency_key FROM conversation_branch_events WHERE branch_id = ? ORDER BY sequence
  `).all(conversationBranchId(sessionId)) as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key);
}

describe('conversation branch legacy backfill probe', () => {
  let db: InstanceType<typeof Database>;

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it('skips the per-session message scan when every session and message is already in the ledger', () => {
    db = createLegacyDb();
    applyConversationBranchSchema(db);
    const before = ledgerCounts(db);
    const prepare = vi.spyOn(db, 'prepare');

    applyConversationBranchSchema(db);

    expect(prepare.mock.calls.filter(([sql]) => PER_SESSION_MESSAGE_SCAN.test(String(sql)))).toHaveLength(0);
    expect(ledgerCounts(db)).toEqual(before);
  });

  it('backfills a session that has no branch yet (even before it has messages)', () => {
    db = createLegacyDb();
    applyConversationBranchSchema(db);
    db.exec(`INSERT INTO sessions VALUES ('s3', 'owner-1', 'project-1', 0, 3)`);

    applyConversationBranchSchema(db);

    expect(db.prepare('SELECT id FROM conversation_branches WHERE session_id = ?').get('s3'))
      .toEqual({ id: conversationBranchId('s3') });
  });

  it('backfills a message written outside the ledger into an existing branch', () => {
    db = createLegacyDb();
    applyConversationBranchSchema(db);
    db.exec(`INSERT INTO messages VALUES ('s1-u2', 's1', 'user', 'late', 50, NULL, 0, 'active', NULL, NULL)`);

    applyConversationBranchSchema(db);

    expect(db.prepare(`
      SELECT alias_kind FROM conversation_branch_entries WHERE branch_id = ? AND projected_message_id = 's1-u2'
    `).get(conversationBranchId('s1'))).toEqual({ alias_kind: 'legacy_backfill' });
  });

  it('backfills legacy rewind and restore events that are not recorded yet', () => {
    db = createLegacyDb();
    applyConversationBranchSchema(db);
    db.exec(`
      INSERT INTO session_rewinds VALUES ('rw-1', 's1', 's1-u1', '["s1-a1"]', 'restored', 70, 60);
    `);

    applyConversationBranchSchema(db);

    expect(eventKeys(db, 's1')).toEqual(expect.arrayContaining(['legacy-rewind:rw-1', 'legacy-rewind-restore:rw-1']));
    const after = ledgerCounts(db);
    applyConversationBranchSchema(db);
    expect(ledgerCounts(db)).toEqual(after);
  });

  it('records a legacy fork quarantine that appears after the sessions were already backfilled', () => {
    db = createLegacyDb();
    applyConversationBranchSchema(db);
    db.exec(`
      INSERT INTO session_forks VALUES ('fork-1', 's1', 's2', 's1', NULL, 's1-a1', 's2-u1', 'completed', 1, 80);
    `);

    applyConversationBranchSchema(db);

    expect(eventKeys(db, 's2').some((key) => key.startsWith('legacy-fork-quarantine:fork-1:'))).toBe(true);
    const after = ledgerCounts(db);
    applyConversationBranchSchema(db);
    expect(ledgerCounts(db)).toEqual(after);
  });
});
