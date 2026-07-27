import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';

describe('schemaConversationBranch legacy migration', () => {
  let db: InstanceType<typeof Database>;

  afterEach(() => db?.close());

  it('widens the immutable event check for projection repair without losing prior events', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE conversation_branches (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT,
        project_id TEXT,
        root_branch_id TEXT NOT NULL,
        parent_branch_id TEXT,
        fork_id TEXT,
        anchor_entry_id TEXT,
        lineage_digest TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_branch_events (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_user_id TEXT,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        previous_event_digest TEXT,
        event_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (branch_id, sequence),
        UNIQUE (branch_id, idempotency_key),
        FOREIGN KEY (branch_id) REFERENCES conversation_branches(id) ON DELETE RESTRICT,
        CHECK (event_type IN (
          'legacy_backfill', 'append', 'message_revision', 'projection_replace',
          'fork', 'rewind', 'rewind_restore', 'evaluation_attribution',
          'quarantine', 'repair_override'
        ))
      );
    `);
    db.prepare(`
      INSERT INTO conversation_branches VALUES (
        'branch-1', 'session-1', 'owner-1', 'project-1', 'branch-1',
        NULL, NULL, NULL, ?, 1, 1
      )
    `).run('a'.repeat(64));
    db.prepare(`
      INSERT INTO conversation_branch_events VALUES (
        'event-1', 'branch-1', 1, 'append', 'append-1', 'owner-1',
        '{}', ?, NULL, ?, 1
      )
    `).run('b'.repeat(64), 'c'.repeat(64));

    applyConversationBranchSchema(db, { backfillLegacy: false });

    expect(db.prepare(`
      SELECT id, event_type, sequence
      FROM conversation_branch_events
      ORDER BY sequence
    `).all()).toEqual([{ id: 'event-1', event_type: 'append', sequence: 1 }]);
    expect(() => db.prepare(`
      INSERT INTO conversation_branch_events VALUES (
        'event-2', 'branch-1', 2, 'projection_repair', 'repair-1', 'owner-1',
        '{}', ?, ?, ?, 2
      )
    `).run('d'.repeat(64), 'c'.repeat(64), 'e'.repeat(64))).not.toThrow();
    expect(() => db.prepare(`
      UPDATE conversation_branch_events SET payload_json = '{}' WHERE id = 'event-1'
    `).run()).toThrow(/immutable/u);
  });

  it('backfills legacy fork mappings as shared immutable entries and is idempotent', () => {
    db = new Database(':memory:');
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
      INSERT INTO sessions VALUES ('source', 'owner-1', 'project-1', 0, 1);
      INSERT INTO sessions VALUES ('child', 'owner-1', 'project-1', 0, 50);
      INSERT INTO messages VALUES ('u1', 'source', 'user', 'one', 10, NULL, 0, 'active', NULL, NULL);
      INSERT INTO messages VALUES (
        'a1', 'source', 'assistant', 'answer', 20, NULL, 0,
        'rewound', 'legacy-rewind', 40
      );
      INSERT INTO messages VALUES ('child-u1', 'child', 'user', 'one', 10, NULL, 0, 'active', NULL, NULL);
      INSERT INTO messages VALUES ('child-a1', 'child', 'assistant', 'answer', 20, NULL, 0, 'active', NULL, NULL);
      INSERT INTO session_forks VALUES (
        'fork-1', 'source', 'child', 'source', NULL, 'a1', 'child-a1', 'completed', 1, 50
      );
      INSERT INTO session_fork_message_map VALUES ('fork-1', 0, 'u1', 'child-u1');
      INSERT INTO session_fork_message_map VALUES ('fork-1', 1, 'a1', 'child-a1');
      INSERT INTO session_rewinds VALUES (
        'legacy-rewind', 'source', 'u1', '["a1"]', 'completed', NULL, 40
      );
    `);
    const sourceBytes = JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY rowid').all());

    applyConversationBranchSchema(db);
    applyConversationBranchSchema(db);

    const repository = new ConversationBranchRepository(db);
    const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;
    const source = repository.replay('source', boundary);
    const child = repository.replay('child', boundary);
    expect(source.messages.map((message) => message.projectedMessageId)).toEqual(['u1']);
    expect(child.messages.map((message) => message.entryId))
      .toEqual(repository.replay('source', boundary, { includeRewound: true }).messages
        .map((message) => message.entryId));
    expect(child.messages.map((message) => message.projectedMessageId))
      .toEqual(['child-u1', 'child-a1']);
    expect(child.lineage.parentSessionId).toBe('source');
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_branches').get())
      .toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_entries').get())
      .toEqual({ count: 2 });
    expect(JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY rowid').all())).toBe(sourceBytes);
  });

  it.each([
    ['missing mapping', 'missing', 'LEGACY_FORK_MAPPING_MISSING'],
    ['ordinal gap', 'gap', 'LEGACY_FORK_MAPPING_GAP'],
    ['unclosed mapping', 'not_closed', 'LEGACY_FORK_MAPPING_NOT_CLOSED'],
    ['anchor mismatch', 'anchor', 'LEGACY_FORK_ANCHOR_MISMATCH'],
    ['payload mismatch', 'payload', 'LEGACY_FORK_PAYLOAD_MISMATCH'],
  ] as const)(
    'quarantines %s instead of manufacturing a shared prefix',
    (_label, corruption, expectedCode) => {
      db = new Database(':memory:');
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
        INSERT INTO sessions VALUES ('source', 'owner-1', 'project-1', 0, 1);
        INSERT INTO sessions VALUES ('child', 'owner-1', 'project-1', 0, 50);
        INSERT INTO messages VALUES ('u1', 'source', 'user', 'one', 10, NULL, 0, 'active', NULL, NULL);
        INSERT INTO messages VALUES ('a1', 'source', 'assistant', 'answer', 20, NULL, 0, 'active', NULL, NULL);
        INSERT INTO messages VALUES ('child-u1', 'child', 'user', 'one', 10, NULL, 0, 'active', NULL, NULL);
        INSERT INTO messages VALUES (
          'child-a1', 'child', 'assistant',
          '${corruption === 'payload' ? 'different answer' : 'answer'}',
          20, NULL, 0, 'active', NULL, NULL
        );
        INSERT INTO session_forks VALUES (
          'fork-1', 'source', 'child', 'source', NULL,
          '${corruption === 'anchor' ? 'u1' : 'a1'}',
          'child-a1', 'completed', 1, 50
        );
      `);
      if (corruption !== 'missing') {
        db.prepare(`
          INSERT INTO session_fork_message_map
          VALUES ('fork-1', 0, 'u1', 'child-u1')
        `).run();
        db.prepare(`
          INSERT INTO session_fork_message_map
          VALUES ('fork-1', ?, ?, 'child-a1')
        `).run(
          corruption === 'gap' ? 2 : 1,
          corruption === 'not_closed' ? 'missing-source' : 'a1',
        );
      }

      applyConversationBranchSchema(db);

      const childBranch = db.prepare(`
        SELECT id, parent_branch_id, fork_id
        FROM conversation_branches
        WHERE session_id = 'child'
      `).get() as { id: string; parent_branch_id: string | null; fork_id: string | null };
      expect(childBranch).toMatchObject({ parent_branch_id: null, fork_id: null });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_entries
        WHERE branch_id = ? AND alias_kind = 'fork_copy'
      `).get(childBranch.id)).toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_events
        WHERE branch_id = ? AND event_type = 'fork'
      `).get(childBranch.id)).toEqual({ count: 0 });
      const quarantine = db.prepare(`
        SELECT payload_json
        FROM conversation_branch_events
        WHERE branch_id = ? AND event_type = 'quarantine'
      `).get(childBranch.id) as { payload_json: string };
      expect(
        (JSON.parse(quarantine.payload_json) as { issues: Array<{ code: string }> })
          .issues.map((issue) => issue.code),
      ).toContain(expectedCode);

      const repository = new ConversationBranchRepository(db);
      expect(() => repository.replay(
        'child',
        { ownerUserId: 'owner-1', projectId: 'project-1' },
      )).toThrow('BRANCH_QUARANTINED');
    },
  );
});
