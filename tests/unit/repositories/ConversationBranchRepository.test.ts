import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import {
  ConversationBranchError,
  ConversationBranchRepository,
} from '../../../src/host/services/core/repositories/ConversationBranchRepository';

const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;

function totalChanges(db: BetterSqlite3.Database): number {
  const row = db.prepare(`
    SELECT total_changes() AS total_changes
  `).get() as { total_changes: number };
  return row.total_changes;
}

function installLegacySchema(db: BetterSqlite3.Database): void {
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
      tool_calls TEXT,
      tool_results TEXT,
      attachments TEXT,
      thinking TEXT,
      effort_level TEXT,
      synced_at INTEGER,
      content_parts TEXT,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      compaction TEXT,
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
  `);
}

function seedRootSession(db: BetterSqlite3.Database, id = 'source'): void {
  db.prepare(`
    INSERT INTO sessions (id, user_id, project_id, is_deleted, created_at)
    VALUES (?, 'owner-1', 'project-1', 0, 1)
  `).run(id);
}

describe('ConversationBranchRepository', () => {
  let db: BetterSqlite3.Database;
  let repository: ConversationBranchRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    installLegacySchema(db);
    seedRootSession(db);
    applyConversationBranchSchema(db);
    // This suite exercises the immutable repository in isolation. Production
    // projection parity is covered by ConversationBranchProductionIntegration.
    repository = new ConversationBranchRepository(db, {
      auditCompatibilityProjection: false,
    });
  });

  afterEach(() => db.close());

  it('records append, revision, and replace as immutable ledger additions', () => {
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
      idempotencyKey: 'append-u1',
    });
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'a1', role: 'assistant', content: 'first', timestamp: 20 },
      idempotencyKey: 'append-a1',
    });
    const beforeRevision = repository.getRawLedgerCounts('source', boundary);

    repository.recordMessageRevision({
      sessionId: 'source',
      boundary,
      targetMessageId: 'a1',
      revisedMessage: { id: 'a1', role: 'assistant', content: 'revised', timestamp: 21 },
      idempotencyKey: 'revise-a1',
      reason: 'model correction',
    });
    expect(repository.replay('source', boundary).messages.map((message) => message.message.content))
      .toEqual(['one', 'revised']);

    repository.recordProjectionReplacement({
      sessionId: 'source',
      boundary,
      messages: [
        { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
        { id: 'a1', role: 'assistant', content: 'replacement', timestamp: 22 },
        { id: 'u2', role: 'user', content: 'two', timestamp: 30 },
      ],
      idempotencyKey: 'replace-projection',
      reason: 'legacy replaceMessages compatibility',
    });

    expect(repository.replay('source', boundary).messages.map((message) => message.message.content))
      .toEqual(['one', 'replacement', 'two']);
    const afterReplacement = repository.getRawLedgerCounts('source', boundary);
    expect(afterReplacement.entries).toBeGreaterThan(beforeRevision.entries);
    expect(afterReplacement.references).toBeGreaterThan(beforeRevision.references);
    expect(afterReplacement.events).toBeGreaterThan(beforeRevision.events);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_entries
      WHERE message_json LIKE '%"content":"first"%'
    `).get()).toEqual({ count: 1 });
  });

  it('shares canonical prefix entries when creating a fork while preserving both message aliases', () => {
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
      idempotencyKey: 'append-u1',
    });
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'a1', role: 'assistant', content: 'answer', timestamp: 20 },
      idempotencyKey: 'append-a1',
    });
    seedRootSession(db, 'child');

    repository.createForkBranch({
      sourceSessionId: 'source',
      childSessionId: 'child',
      sourceAnchorMessageId: 'a1',
      childAnchorMessageId: 'child-a1',
      forkId: 'fork-1',
      boundary,
      messageAliases: [
        { sourceMessageId: 'u1', childMessageId: 'child-u1' },
        { sourceMessageId: 'a1', childMessageId: 'child-a1' },
      ],
      idempotencyKey: 'fork-ledger-1',
      createdAt: 50,
    });

    const source = repository.replay('source', boundary);
    const child = repository.replay('child', boundary);
    expect(child.messages.map((message) => message.entryId))
      .toEqual(source.messages.map((message) => message.entryId));
    expect(child.messages.map((message) => message.projectedMessageId))
      .toEqual(['child-u1', 'child-a1']);
    expect(child.messages.map((message) => message.sourceMessageId))
      .toEqual(['u1', 'a1']);
    expect(child.lineage).toMatchObject({
      sessionId: 'child',
      parentSessionId: 'source',
      forkId: 'fork-1',
      anchorEntryId: source.messages[1].entryId,
    });

    const sourceBytes = JSON.stringify(repository.replay('source', boundary));
    repository.appendMessage({
      sessionId: 'child',
      boundary,
      message: { id: 'child-u2', role: 'user', content: 'branch only', timestamp: 60 },
      idempotencyKey: 'append-child-u2',
    });
    expect(JSON.stringify(repository.replay('source', boundary))).toBe(sourceBytes);
  });

  it('fails closed when lineage metadata or the exact shared prefix is corrupt', () => {
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
      idempotencyKey: 'append-u1',
    });
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'a1', role: 'assistant', content: 'answer', timestamp: 20 },
      idempotencyKey: 'append-a1',
    });
    seedRootSession(db, 'child');
    repository.createForkBranch({
      sourceSessionId: 'source',
      childSessionId: 'child',
      sourceAnchorMessageId: 'a1',
      childAnchorMessageId: 'child-a1',
      forkId: 'fork-1',
      boundary,
      messageAliases: [
        { sourceMessageId: 'u1', childMessageId: 'child-u1' },
        { sourceMessageId: 'a1', childMessageId: 'child-a1' },
      ],
      idempotencyKey: 'fork-ledger-1',
    });
    const childBranch = repository.getBranch('child', boundary);
    const sourceFirstEntry = repository.replay('source', boundary).messages[0].entryId;

    // Simulate an imported/corrupt database that bypassed the immutable guards.
    db.exec(`
      DROP TRIGGER conversation_branches_immutable_update;
      DROP TRIGGER conversation_branch_entries_immutable_update;
    `);
    db.prepare(`
      UPDATE conversation_branches
      SET root_branch_id = 'missing-root',
          parent_branch_id = 'missing-parent',
          anchor_entry_id = ?,
          lineage_digest = ?
      WHERE id = ?
    `).run(sourceFirstEntry, '0'.repeat(64), childBranch.branchId);
    db.prepare(`
      UPDATE conversation_branch_entries
      SET alias_kind = 'native'
      WHERE branch_id = ? AND ordinal = 0
    `).run(childBranch.branchId);

    const audit = repository.auditLineage('child', boundary);
    expect(audit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'BRANCH_LINEAGE_DIGEST_MISMATCH',
      'ROOT_BRANCH_MISSING',
      'PARENT_BRANCH_MISSING',
      'FORK_PREFIX_NOT_CONTIGUOUS',
      'FORK_ANCHOR_MISMATCH',
    ]));
    expect(() => repository.replay('child', boundary)).toThrow('BRANCH_QUARANTINED');
  });

  it('appends rewind and restore events without deleting or updating entries or references', () => {
    for (const [id, role, content, timestamp] of [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'second answer', 35],
    ] as const) {
      repository.appendMessage({
        sessionId: 'source',
        boundary,
        message: { id, role, content, timestamp },
        idempotencyKey: `append-${id}`,
      });
    }
    const counts = repository.getRawLedgerCounts('source', boundary);
    const beforeInvalid = totalChanges(db);
    expect(() => repository.recordRewind({
      sessionId: 'source',
      boundary,
      anchorMessageId: 'u2',
      hiddenMessageIds: ['u2', 'a2'],
      rewindId: 'rewind-invalid-order',
      idempotencyKey: 'rewind-invalid-order',
      createdAt: 39,
    })).toThrow('INVALID_REWIND');
    expect(totalChanges(db)).toBe(beforeInvalid);

    const rewind = repository.recordRewind({
      sessionId: 'source',
      boundary,
      anchorMessageId: 'u2',
      hiddenMessageIds: ['a2'],
      rewindId: 'rewind-1',
      idempotencyKey: 'rewind-1',
      createdAt: 40,
    });
    expect(rewind.hiddenMessageIds).toEqual(['a2']);
    expect(repository.replay('source', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['u1', 'a1', 'u2']);
    expect(repository.getRawLedgerCounts('source', boundary)).toEqual({
      ...counts,
      events: counts.events + 1,
    });

    repository.recordRewindRestore({
      sessionId: 'source',
      boundary,
      rewindId: 'rewind-1',
      idempotencyKey: 'restore-rewind-1',
      createdAt: 50,
    });
    expect(repository.replay('source', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(repository.getRawLedgerCounts('source', boundary)).toEqual({
      ...counts,
      events: counts.events + 2,
    });

    const before = totalChanges(db);
    expect(() => repository.recordRewind({
      sessionId: 'source',
      boundary,
      anchorMessageId: 'missing',
      hiddenMessageIds: [],
      rewindId: 'rewind-bad',
      idempotencyKey: 'rewind-bad',
    })).toThrowError(ConversationBranchError);
    expect(totalChanges(db)).toBe(before);
  });

  it('compares branches, traces shared provenance, and stores evaluation attribution as events', () => {
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
      idempotencyKey: 'append-u1',
    });
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'a1', role: 'assistant', content: 'answer', timestamp: 20 },
      idempotencyKey: 'append-a1',
    });
    seedRootSession(db, 'child');
    repository.createForkBranch({
      sourceSessionId: 'source',
      childSessionId: 'child',
      sourceAnchorMessageId: 'a1',
      childAnchorMessageId: 'child-a1',
      forkId: 'fork-1',
      boundary,
      messageAliases: [
        { sourceMessageId: 'u1', childMessageId: 'child-u1' },
        { sourceMessageId: 'a1', childMessageId: 'child-a1' },
      ],
      idempotencyKey: 'fork-ledger-1',
    });
    repository.appendMessage({
      sessionId: 'child',
      boundary,
      message: { id: 'child-u2', role: 'user', content: 'alternate', timestamp: 30 },
      idempotencyKey: 'append-child-u2',
    });

    const comparison = repository.compareBranches({
      leftSessionId: 'source',
      rightSessionId: 'child',
      boundary,
    });
    expect(comparison.sharedPrefixLength).toBe(2);
    expect(comparison.leftOnly).toEqual([]);
    expect(comparison.rightOnly.map((message) => message.projectedMessageId)).toEqual(['child-u2']);

    const provenance = repository.traceProvenance({
      sessionId: 'child',
      messageId: 'child-a1',
      boundary,
    });
    expect(provenance.canonicalSource).toEqual({ sessionId: 'source', messageId: 'a1' });
    expect(provenance.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'source', messageId: 'a1' }),
      expect.objectContaining({ sessionId: 'child', messageId: 'child-a1' }),
    ]));

    repository.recordEvaluationAttribution({
      sessionId: 'child',
      boundary,
      evaluationId: 'eval-1',
      runId: 'run-1',
      metric: 'quality',
      value: 0.9,
      attributedMessageIds: ['child-a1', 'child-u2'],
      idempotencyKey: 'evaluation-1',
    });
    expect(repository.listEvaluationAttributions('child', boundary)).toEqual([
      expect.objectContaining({
        evaluationId: 'eval-1',
        runId: 'run-1',
        metric: 'quality',
        value: 0.9,
        entryIds: [
          provenance.entry.id,
          repository.traceProvenance({
            sessionId: 'child',
            messageId: 'child-u2',
            boundary,
          }).entry.id,
        ],
      }),
    ]);
  });

  it('fails closed across owner and project boundaries with zero writes', () => {
    const before = totalChanges(db);
    expect(() => repository.appendMessage({
      sessionId: 'source',
      boundary: { ownerUserId: 'intruder', projectId: 'project-1' },
      message: { id: 'u1', role: 'user', content: 'blocked', timestamp: 10 },
      idempotencyKey: 'blocked-owner',
    })).toThrow('OWNER_MISMATCH');
    expect(() => repository.appendMessage({
      sessionId: 'source',
      boundary: { ownerUserId: 'owner-1', projectId: 'project-2' },
      message: { id: 'u1', role: 'user', content: 'blocked', timestamp: 10 },
      idempotencyKey: 'blocked-project',
    })).toThrow('PROJECT_MISMATCH');
    expect(totalChanges(db)).toBe(before);
  });

  it('quarantines a corrupt hash chain and only permits an auditable override', () => {
    repository.appendMessage({
      sessionId: 'source',
      boundary,
      message: { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
      idempotencyKey: 'append-u1',
    });
    const branch = repository.getBranch('source', boundary);
    db.prepare(`
      INSERT INTO conversation_branch_events (
        id, branch_id, sequence, event_type, idempotency_key, actor_user_id,
        payload_json, payload_digest, previous_event_digest, event_digest, created_at
      ) VALUES (
        'corrupt-event', ?, 2, 'append', 'corrupt', 'owner-1',
        '{}',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '1111111111111111111111111111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222222222222222222222222222',
        20
      )
    `).run(branch.branchId);

    const audit = repository.auditLineage('source', boundary);
    expect(audit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'EVENT_PAYLOAD_DIGEST_MISMATCH',
      'EVENT_CHAIN_MISMATCH',
      'EVENT_DIGEST_MISMATCH',
    ]));
    const quarantine = repository.auditAndQuarantine({
      sessionId: 'source',
      boundary,
      idempotencyKey: 'quarantine-corrupt',
    });
    expect(quarantine.status).toBe('quarantined');
    expect(() => repository.replay('source', boundary)).toThrow('BRANCH_QUARANTINED');

    repository.recordRepairOverride({
      sessionId: 'source',
      boundary,
      issueDigest: quarantine.issueDigest,
      reason: 'operator accepted imported legacy evidence after independent verification',
      idempotencyKey: 'repair-override-1',
    });
    expect(repository.auditLineage('source', boundary).status).toBe('override_active');
    expect(repository.replay('source', boundary, { allowRepairOverride: true }).messages)
      .toHaveLength(1);
    expect(() => db.prepare(`
      UPDATE conversation_branch_events SET payload_json = '{}' WHERE id = 'corrupt-event'
    `).run()).toThrow(/immutable/);
    expect(() => db.prepare(`
      DELETE FROM conversation_entries
    `).run()).toThrow(/immutable/);
  });
});
