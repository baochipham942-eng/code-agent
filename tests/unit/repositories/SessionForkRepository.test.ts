import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { SessionForkRepository } from '../../../src/host/services/core/repositories/SessionForkRepository';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

function totalChanges(db: BetterSqlite3.Database): number {
  const row = db.prepare(`
    SELECT total_changes() AS total_changes
  `).get() as { total_changes: number };
  return row.total_changes;
}

function seedSource(db: BetterSqlite3.Database, status = 'completed'): void {
  db.prepare(`
    INSERT INTO sessions (
      id, user_id, title, model_provider, model_name, working_directory,
      session_type, origin, metadata, parent_session_id, source_run_id,
      agent_engine, memory_mode, suppressed_memory_entry_ids, read_only,
      retry_of_session_id, created_at, updated_at, workspace,
      workbench_provenance, status, last_token_usage, is_deleted, synced_at,
      git_branch, project_id
    )
    VALUES (
      'source', 'user-1', 'Source task', 'openai', 'gpt-5.4', '/workspace/source',
      'chat', '{"kind":"manual"}', '{"unsafeRuntimeLease":"must-not-copy"}',
      NULL, 'old-source-run',
      '{"kind":"codex_cli","model":"gpt-5.4","runId":"old-run","externalSessionId":"provider-session","logPath":"/tmp/provider.log","permissionProfile":"workspace_write","cwd":"/workspace/source"}',
      'off', '["memory-secret-id"]', 0, NULL, 1, 50, 'workspace-source',
      '{"activities":["browser"],"connectorGrant":"connector-secret","browserSession":"browser-runtime"}',
      ?, '{"totalTokens":999}', 0, NULL,
      'main', 'project-1'
    )
  `).run(status);

  const insert = db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, timestamp, tool_calls, tool_results,
      attachments, thinking, effort_level, synced_at, content_parts, metadata,
      is_meta, compaction, visibility, hidden_by_rewind_id, hidden_at
    )
    VALUES (?, 'source', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 'active', NULL, NULL)
  `);
  insert.run('u1', 'user', 'one', 10);
  insert.run('a1', 'assistant', 'one answer', 20);
  insert.run('u2', 'user', 'two', 30);
  insert.run('a2', 'assistant', 'two answer', 40);
  // Same timestamp as the anchor: row insertion order is the stable boundary.
  insert.run('u3', 'user', 'three', 40);
}

function forkInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceSessionId: 'source',
    anchorAssistantMessageId: 'a2',
    idempotencyKey: 'fork-key-1',
    forkId: 'fork-1',
    childSessionId: 'child-1',
    childTitle: 'Source task · Branch',
    workspaceMode: 'shared_current' as const,
    contextDeliveryMode: 'validated_context_handoff' as const,
    ownerUserId: 'user-1',
    now: 100,
    ...overrides,
  };
}

describe('SessionForkRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionForkRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    seedSource(db);
    repo = new SessionForkRepository(db);
  });

  afterEach(() => db.close());

  it('creates an independent child through the completed assistant anchor without mutating source bytes', () => {
    const sourceSessionBefore = JSON.stringify(
      db.prepare('SELECT * FROM sessions WHERE id = ?').get('source'),
    );
    const sourceMessagesBefore = JSON.stringify(
      db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid').all('source'),
    );

    const result = repo.createFork(forkInput());

    expect(result.childSessionId).toBe('child-1');
    expect(result.copiedMessageCount).toBe(4);
    expect(
      db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid').all('child-1'),
    ).toEqual([
      { content: 'one' },
      { content: 'one answer' },
      { content: 'two' },
      { content: 'two answer' },
    ]);
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions WHERE id = ?').get('source')))
      .toBe(sourceSessionBefore);
    expect(JSON.stringify(db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid').all('source')))
      .toBe(sourceMessagesBefore);
  });

  it('uses the stable (timestamp, rowid) anchor boundary for out-of-order timestamps', () => {
    db.prepare("UPDATE messages SET timestamp = 50 WHERE id = 'u2'").run();
    db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, timestamp, visibility, is_meta
      ) VALUES ('late-old', 'source', 'user', 'inserted late with older timestamp', 15, 'active', 0)
    `).run();

    const result = repo.createFork(forkInput());

    expect(result.messageMappings.map((mapping) => mapping.sourceMessageId)).toEqual([
      'u1',
      'late-old',
      'a1',
      'a2',
    ]);
    expect(result.messageMappings.map((mapping) => mapping.sourceOrderKey)).toEqual([
      expect.stringMatching(/^10:/),
      expect.stringMatching(/^15:/),
      expect.stringMatching(/^20:/),
      expect.stringMatching(/^40:/),
    ]);
    expect(result.messageMappings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMessageId: 'u2' }),
      expect.objectContaining({ sourceMessageId: 'u3' }),
    ]));
  });

  it('persists explicit lineage and one-to-one message mapping while parentSessionId stays a compatibility projection', () => {
    repo.createFork(forkInput());

    const child = db.prepare(`
      SELECT parent_session_id, project_id, working_directory, workspace, model_provider,
             model_name, memory_mode, suppressed_memory_entry_ids, status, source_run_id,
             last_token_usage, metadata, agent_engine, workbench_provenance
      FROM sessions WHERE id = 'child-1'
    `).get() as Record<string, unknown>;
    expect(child).toMatchObject({
      parent_session_id: 'source',
      project_id: 'project-1',
      working_directory: '/workspace/source',
      workspace: 'workspace-source',
      model_provider: 'openai',
      model_name: 'gpt-5.4',
      memory_mode: 'off',
      suppressed_memory_entry_ids: '["memory-secret-id"]',
      status: 'idle',
      source_run_id: null,
      last_token_usage: null,
      workbench_provenance: null,
    });
    expect(JSON.parse(String(child.agent_engine))).toEqual({
      kind: 'codex_cli',
      model: 'gpt-5.4',
      permissionProfile: 'read_only',
      origin: 'manual',
      cwd: '/workspace/source',
    });
    expect(JSON.parse(String(child.metadata))).not.toHaveProperty('unsafeRuntimeLease');

    expect(db.prepare(`
      SELECT id, source_session_id, child_session_id, anchor_message_id, workspace_mode,
             context_delivery_mode, status
      FROM session_forks
    `).get()).toEqual({
      id: 'fork-1',
      source_session_id: 'source',
      child_session_id: 'child-1',
      anchor_message_id: 'a2',
      workspace_mode: 'shared_current',
      context_delivery_mode: 'validated_context_handoff',
      status: 'completed',
    });
    expect(db.prepare(`
      SELECT source_message_id, child_message_id, ordinal
      FROM session_fork_message_map
      ORDER BY ordinal
    `).all()).toEqual([
      expect.objectContaining({ source_message_id: 'u1', ordinal: 0 }),
      expect.objectContaining({ source_message_id: 'a1', ordinal: 1 }),
      expect.objectContaining({ source_message_id: 'u2', ordinal: 2 }),
      expect.objectContaining({ source_message_id: 'a2', ordinal: 3 }),
    ]);
  });

  it('clears native executable authority for a shared-current child', () => {
    db.prepare(`
      UPDATE sessions
      SET agent_engine = ?
      WHERE id = 'source'
    `).run(JSON.stringify({
      kind: 'native',
      model: 'gpt-5.4',
      permissionProfile: 'bypass_permissions',
      origin: 'manual',
      cwd: '/workspace/source',
      runId: 'source-run',
    }));

    repo.createFork(forkInput({ contextDeliveryMode: 'neo_native_prefix' }));

    const child = db.prepare(`
      SELECT read_only, agent_engine
      FROM sessions
      WHERE id = 'child-1'
    `).get() as { read_only: number; agent_engine: string };
    expect(child.read_only).toBe(0);
    expect(JSON.parse(child.agent_engine)).toEqual({
      kind: 'native',
      model: 'gpt-5.4',
      permissionProfile: 'read_only',
      origin: 'manual',
      cwd: '/workspace/source',
    });
  });

  it('returns the same child for a repeated idempotency key', () => {
    const first = repo.createFork(forkInput());
    const second = repo.createFork(forkInput({
      forkId: 'fork-ignored',
      childSessionId: 'child-ignored',
    }));

    expect(second).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_forks').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE parent_session_id = 'source'").get())
      .toEqual({ count: 1 });
  });

  it.each([
    ['user anchor', { anchorAssistantMessageId: 'u2' }, 'ANCHOR_NOT_COMPLETED_ASSISTANT'],
    ['missing anchor', { anchorAssistantMessageId: 'missing' }, 'INVALID_ANCHOR'],
  ])('rejects %s with zero writes', (_label, overrides, code) => {
    const before = totalChanges(db);
    expect(() => repo.createFork(forkInput(overrides))).toThrow(code);
    expect(totalChanges(db)).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_forks').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-1'").get()).toEqual({ count: 0 });
  });

  it('rejects a rewound anchor with zero writes', () => {
    db.prepare(`
      UPDATE messages
      SET visibility = 'rewound', hidden_by_rewind_id = 'rewind-1', hidden_at = 90
      WHERE id = 'a2'
    `).run();
    const before = totalChanges(db);

    expect(() => repo.createFork(forkInput())).toThrow('ANCHOR_REWOUND');
    expect(totalChanges(db)).toBe(before);
  });

  it('rejects a running source with zero writes', () => {
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = 'source'").run();
    const before = totalChanges(db);

    expect(() => repo.createFork(forkInput())).toThrow('SESSION_RUNNING');
    expect(totalChanges(db)).toBe(before);
  });

  it('rechecks the persistent source status inside the transaction before writing', () => {
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(((fn: () => unknown) => {
      const transactional = originalTransaction(fn);
      const wrapped = (() => {
        db.prepare("UPDATE sessions SET status = 'running' WHERE id = 'source'").run();
        return transactional.immediate();
      }) as typeof transactional;
      wrapped.deferred = wrapped;
      wrapped.immediate = wrapped;
      wrapped.exclusive = wrapped;
      return wrapped;
    }) as typeof db.transaction);

    expect(() => repo.createFork(forkInput())).toThrow('SESSION_RUNNING');
    expect(db.prepare("SELECT status FROM sessions WHERE id = 'source'").get()).toEqual({ status: 'running' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-1'").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_forks').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'child-1'").get()).toEqual({ count: 0 });
  });

  it('reads and validates the anchor inside the immediate transaction with zero stale-prefix writes', () => {
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(((fn: () => unknown) => {
      const transactional = originalTransaction(fn);
      const wrapped = (() => {
        db.prepare(`
          UPDATE messages
          SET visibility = 'rewound', hidden_by_rewind_id = 'rewind-before-lock', hidden_at = 99
          WHERE id = 'a2'
        `).run();
        return transactional.immediate();
      }) as typeof transactional;
      wrapped.deferred = wrapped;
      wrapped.immediate = wrapped;
      wrapped.exclusive = wrapped;
      return wrapped;
    }) as typeof db.transaction);

    expect(() => repo.createFork(forkInput())).toThrow('ANCHOR_REWOUND');
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-1'").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_forks').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'child-1'").get()).toEqual({ count: 0 });
  });

  it('rejects an active durable run even when the session compatibility status is idle', () => {
    db.exec(`
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        status TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO durable_runs (run_id, session_id, parent_run_id, status)
      VALUES ('run-1', 'source', NULL, 'recovering')
    `).run();
    const before = totalChanges(db);

    expect(() => repo.createFork(forkInput())).toThrow('SESSION_RUNNING');
    expect(totalChanges(db)).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-1'").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_forks').get()).toEqual({ count: 0 });
  });

  it('enforces string and null owner scopes while preserving undefined for internal compatibility', () => {
    const before = totalChanges(db);
    expect(() => repo.createFork(forkInput({ ownerUserId: 'user-2' }))).toThrow('SESSION_NOT_FOUND');
    expect(() => repo.createFork(forkInput({ ownerUserId: null }))).toThrow('SESSION_NOT_FOUND');
    expect(totalChanges(db)).toBe(before);
    expect(repo.getLineage('child-1', 'user-2')).toBeNull();
    expect(repo.listChildren('source', 'user-2')).toEqual([]);

    const result = repo.createFork(forkInput({ ownerUserId: undefined }));
    expect(repo.getLineage(result.childSessionId)).toMatchObject({ forkId: result.forkId });
    expect(repo.listChildren('source')).toHaveLength(1);
  });

  it('returns lineage only when both source and child are in the requested owner scope', () => {
    repo.createFork(forkInput());
    const before = totalChanges(db);

    expect(repo.getLineage('child-1', 'user-1')).toMatchObject({ forkId: 'fork-1' });
    expect(repo.listChildren('source', 'user-1')).toHaveLength(1);
    expect(repo.getLineage('child-1', 'user-2')).toBeNull();
    expect(repo.getLineage('child-1', null)).toBeNull();
    expect(repo.listChildren('source', 'user-2')).toEqual([]);
    expect(repo.listChildren('source', null)).toEqual([]);
    expect(totalChanges(db)).toBe(before);
  });

  it('keeps a child lineage auditable after its parent is soft-deleted', () => {
    repo.createFork(forkInput());
    db.prepare("UPDATE sessions SET is_deleted = 1 WHERE id = 'source'").run();

    expect(repo.getLineage('child-1', 'user-1')).toMatchObject({
      forkId: 'fork-1',
      parentSessionId: 'source',
      childSessionId: 'child-1',
      parentDeleted: true,
    });
    expect(repo.getLineage('child-1', 'user-2')).toBeNull();
    expect(repo.listChildren('source', 'user-1')).toEqual([
      expect.objectContaining({
        forkId: 'fork-1',
        parentDeleted: true,
      }),
    ]);

    db.prepare("UPDATE sessions SET is_deleted = 0 WHERE id = 'source'").run();
    expect(repo.getLineage('child-1', 'user-1')).toMatchObject({ parentDeleted: false });
  });

  it('rolls back child, lineage, and copied messages when mapping persistence fails', () => {
    db.exec(`
      CREATE TRIGGER fail_fork_mapping
      BEFORE INSERT ON session_fork_message_map
      BEGIN
        SELECT RAISE(ABORT, 'injected mapping failure');
      END
    `);

    expect(() => repo.createFork(forkInput())).toThrow('injected mapping failure');
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-1'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'child-1'").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_forks').get()).toEqual({ count: 0 });
  });

  it('reconstructs the mapped active prefix for external runtime delivery', () => {
    repo.createFork(forkInput());

    const source = repo.getContextSource('child-1');

    expect(source?.lineage.childSessionId).toBe('child-1');
    expect(source?.sourcePrefixDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(source?.mappedActivePrefix.map((entry) => [
      entry.ordinal,
      entry.sourceMessageId,
      entry.childMessageId,
      entry.message.content,
    ])).toEqual([
      [0, 'u1', expect.any(String), 'one'],
      [1, 'a1', expect.any(String), 'one answer'],
      [2, 'u2', expect.any(String), 'two'],
      [3, 'a2', expect.any(String), 'two answer'],
    ]);
  });

  it('rejects a suffix-truncated child prefix even when the remaining ordinals are contiguous', () => {
    repo.createFork(forkInput());
    db.prepare(`
      DELETE FROM messages
      WHERE id IN (
        SELECT child_message_id
        FROM session_fork_message_map
        WHERE fork_id = 'fork-1' AND ordinal > 0
      )
    `).run();
    const before = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(before);
  });

  it('rejects a suffix-truncated mapping ledger even when its remaining rows are contiguous', () => {
    repo.createFork(forkInput());
    db.prepare(`
      DELETE FROM session_fork_message_map
      WHERE fork_id = 'fork-1' AND ordinal > 0
    `).run();
    const before = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(before);
  });

  it('rejects mapping rows that resolve outside the child session or orphan their source row', () => {
    repo.createFork(forkInput());
    db.prepare(`
      UPDATE session_fork_message_map
      SET child_message_id = 'a2'
      WHERE fork_id = 'fork-1' AND ordinal = 3
    `).run();
    const wrongChildBefore = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(wrongChildBefore);

    db.prepare(`
      UPDATE session_fork_message_map
      SET child_message_id = (
        SELECT id FROM messages WHERE session_id = 'child-1' AND content = 'two answer'
      ),
          source_message_id = 'missing-source-message'
      WHERE fork_id = 'fork-1' AND ordinal = 3
    `).run();
    const orphanSourceBefore = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(orphanSourceBefore);
  });

  it('rejects copied child drift while keeping the sealed context independent from later source projection changes', () => {
    repo.createFork(forkInput());
    db.prepare("UPDATE messages SET content = 'tampered child' WHERE session_id = 'child-1' AND content = 'two'")
      .run();
    const childDriftBefore = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(childDriftBefore);

    db.prepare("UPDATE messages SET content = 'two' WHERE session_id = 'child-1' AND content = 'tampered child'")
      .run();
    db.prepare(`
      UPDATE messages
      SET content = 'later source projection',
          synced_at = 999,
          visibility = 'rewound',
          hidden_by_rewind_id = 'later-rewind',
          hidden_at = 999
      WHERE id = 'u2'
    `).run();
    const sourceDriftBefore = totalChanges(db);

    expect(repo.getContextSource('child-1')?.mappedActivePrefix.map((entry) => entry.message.content))
      .toEqual(['one', 'one answer', 'two', 'two answer']);
    expect(totalChanges(db)).toBe(sourceDriftBefore);
  });

  it('rejects fork anchor metadata that no longer terminates at the mapped source and child pair', () => {
    repo.createFork(forkInput());
    db.prepare(`
      UPDATE session_forks
      SET anchor_message_id = 'a1',
          anchor_child_message_id = (
            SELECT child_message_id
            FROM session_fork_message_map
            WHERE fork_id = 'fork-1' AND ordinal = 1
          )
      WHERE id = 'fork-1'
    `).run();
    const before = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(before);
  });

  it('rejects a fork whose persisted prefix digest no longer matches both projections', () => {
    repo.createFork(forkInput());
    db.prepare("UPDATE session_forks SET source_prefix_digest = ? WHERE id = 'fork-1'")
      .run('f'.repeat(64));
    const before = totalChanges(db);

    expect(() => repo.getContextSource('child-1')).toThrow('CONTEXT_HANDOFF_REJECTED');
    expect(totalChanges(db)).toBe(before);
  });

  it('persists a fail-closed context handoff dispatch lifecycle', () => {
    repo.createFork(forkInput());

    expect(repo.prepareContextHandoff('fork-1', 'codex_cli', 'b'.repeat(64), 110))
      .toMatchObject({ state: 'pending', payloadDigest: 'b'.repeat(64) });
    expect(repo.markContextHandoffDispatching('fork-1', 'b'.repeat(64), 'attempt-1', 120))
      .toMatchObject({ state: 'dispatching', attemptId: 'attempt-1' });
    expect(repo.markContextHandoffConsumed('fork-1', 'b'.repeat(64), 'attempt-1', 130))
      .toMatchObject({ state: 'consumed', consumedAt: 130 });
    expect(() => repo.prepareContextHandoff('fork-1', 'codex_cli', 'b'.repeat(64), 140))
      .toThrow('CONTEXT_HANDOFF_REJECTED');
  });

  it('quarantines an interrupted dispatch on restart instead of replaying it', () => {
    repo.createFork(forkInput());
    repo.prepareContextHandoff('fork-1', 'claude_code', 'c'.repeat(64), 110);
    repo.markContextHandoffDispatching('fork-1', 'c'.repeat(64), 'attempt-1', 120);

    expect(repo.recoverInterruptedContextHandoffs(200)).toBe(1);
    expect(repo.getContextHandoff('fork-1')).toMatchObject({
      state: 'blocked',
      error: { code: 'INTERRUPTED_DISPATCH', recoveredAt: 200 },
    });
    expect(() => repo.prepareContextHandoff('fork-1', 'claude_code', 'c'.repeat(64), 210))
      .toThrow('CONTEXT_HANDOFF_REJECTED');
  });
});
