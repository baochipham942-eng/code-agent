import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { SessionForkRepository } from '../../../src/host/services/core/repositories/SessionForkRepository';
import { SessionForkWorkspaceRepository } from '../../../src/host/services/core/repositories/SessionForkWorkspaceRepository';
import type { AnchorWorkspaceEvidence } from '../../../src/host/services/sessionFork/workspace';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

function seedSource(db: BetterSqlite3.Database): void {
  db.prepare(`
    INSERT INTO sessions (
      id, user_id, title, model_provider, model_name, working_directory,
      session_type, origin, metadata, parent_session_id, source_run_id,
      agent_engine, memory_mode, suppressed_memory_entry_ids, read_only,
      retry_of_session_id, created_at, updated_at, workspace,
      workbench_provenance, status, last_token_usage, is_deleted, synced_at,
      git_branch, project_id
    ) VALUES (
      'source', 'owner', 'Source', 'openai', 'gpt-5', '/repo',
      'chat', '{"kind":"manual"}', '{}', NULL, NULL,
      '{"kind":"native","cwd":"/repo"}', 'auto', '[]', 0,
      NULL, 1, 1, 'workspace', NULL, 'completed', NULL, 0, NULL,
      'main', 'project-1'
    )
  `).run();
  const insert = db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, timestamp, is_meta, visibility
    ) VALUES (?, 'source', ?, ?, ?, 0, 'active')
  `);
  insert.run('u1', 'user', 'question', 10);
  insert.run('a1', 'assistant', 'answer', 20);
}

function evidence(): AnchorWorkspaceEvidence {
  return {
    manifest: {
      version: 1,
      captureState: 'complete',
      anchorId: 'a1',
      capturedAt: 30,
      baseCommit: 'a'.repeat(40),
      baseCommitSource: 'explicit_anchor_input',
      observedHead: 'a'.repeat(40),
      workspaceScopeVersion: 'scope-v1',
      repositoryIdentity: {
        canonicalRoot: '/repo',
        canonicalGitCommonDirectory: '/repo/.git',
        rootDevice: '1',
        rootInode: '2',
        gitCommonDevice: '1',
        gitCommonInode: '3',
        objectFormat: 'sha1',
        fingerprint: 'identity',
      },
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: '/repo',
        repositoryRelativePath: '.',
        isolatedRelativePath: '.',
      }],
      stagedPatch: { sha256: 'staged', sizeBytes: 0 },
      unstagedPatch: { sha256: 'unstaged', sizeBytes: 0 },
      untrackedFiles: [],
      evidenceDigest: 'evidence-digest',
    },
    payload: {
      stagedPatchBase64: '',
      unstagedPatchBase64: '',
      untrackedBlobs: {},
    },
  };
}

describe('SessionForkWorkspaceRepository', () => {
  let db: BetterSqlite3.Database;
  let workspaceRepo: SessionForkWorkspaceRepository;
  let forkRepo: SessionForkRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyIndexes(db);
    seedSource(db);
    workspaceRepo = new SessionForkWorkspaceRepository(db);
    forkRepo = new SessionForkRepository(db);
  });

  afterEach(() => db.close());

  function recordEvidence() {
    return workspaceRepo.recordAnchorEvidence({
      sourceSessionId: 'source',
      anchorMessageId: 'a1',
      ownerUserId: 'owner',
      projectId: 'project-1',
      workspaceScopeVersion: 'scope-v1',
      sourceIdentityDigest: 'source-identity',
      sourceIdentity: { projectId: 'project-1' },
      messageDigest: 'message-digest',
      repositoryRoot: '/repo',
      evidence: evidence(),
      status: 'complete',
      now: 30,
    });
  }

  it('persists owner-bound anchor evidence and refuses cross-owner reads', () => {
    const persisted = recordEvidence();

    expect(persisted.status).toBe('complete');
    expect(persisted.summary).toEqual({});
    expect(workspaceRepo.getAnchorEvidence('source', 'a1', 'owner')?.id).toBe(persisted.id);
    expect(workspaceRepo.getAnchorEvidence('source', 'a1', 'another-owner')).toBeNull();
  });

  it('persists intent revisions as valid canonical JSON when optional errors are cleared', async () => {
    recordEvidence();
    const original = await workspaceRepo.create({
      version: 1,
      revision: 0,
      intentId: 'intent-json',
      requestDigest: 'intent-request',
      sourceSessionId: 'source',
      proposedChildSessionId: 'child-json',
      repositoryRoot: '/repo',
      workspacePath: '/durable/child-json',
      evidence: evidence(),
      evidenceDigest: 'evidence-digest',
      status: 'recorded',
      advertisable: false,
      attempts: 0,
      lastError: {
        code: 'OLD',
        message: 'old failure',
        at: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    });

    const updated = await workspaceRepo.update(original.intentId, original.revision, {
      lastError: undefined,
      status: 'worktree_created',
      updatedAt: 2,
    });

    expect(updated.lastError).toBeUndefined();
    expect((await workspaceRepo.get(original.intentId))?.status).toBe('worktree_created');
  });

  it('keeps the child invisible until the verified workspace is advertised', () => {
    const anchorEvidence = recordEvidence();
    const saga = workspaceRepo.beginSaga({
      sourceSessionId: 'source',
      anchorMessageId: 'a1',
      idempotencyKey: 'request-1',
      requestDigest: 'request-digest',
      evidenceId: anchorEvidence.id,
      proposedForkId: 'fork-1',
      proposedChildSessionId: 'child-1',
      contextDeliveryMode: 'neo_native_prefix',
      childTitle: 'Source · branch',
      now: 40,
    });
    workspaceRepo.markSagaWorkspaceReady(saga.intentId, '/durable/child-1', 41);

    const staged = workspaceRepo.stageChild(saga.intentId, (current) => forkRepo.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a1',
      idempotencyKey: 'request-1',
      ownerUserId: 'owner',
      forkId: current.proposedForkId,
      childSessionId: current.proposedChildSessionId,
      childTitle: current.childTitle,
      workspaceMode: 'isolated_at_anchor',
      contextDeliveryMode: 'neo_native_prefix',
      childWorkingDirectory: '/durable/child-1',
      workspaceSnapshotId: current.intentId,
      now: 42,
    }), 42);

    expect(staged.childSessionId).toBe('child-1');
    const stagedChild = db.prepare(`
      SELECT is_deleted, metadata FROM sessions WHERE id = ?
    `).get('child-1') as { is_deleted: number; metadata: string };
    expect(stagedChild.is_deleted).toBe(1);
    expect(JSON.parse(stagedChild.metadata)).toMatchObject({
      forkWorkspaceScopeV1: {
        version: 1,
        intentId: saga.intentId,
        projectId: 'project-1',
        sourceWorkspaceScopeVersion: 'scope-v1',
        sourcePrimaryRoot: '/repo',
        isolatedPrimaryRoot: '/durable/child-1',
        baseCommit: 'a'.repeat(40),
        evidenceDigest: 'evidence-digest',
      },
    });
    expect(db.prepare('SELECT status, workspace_snapshot_id FROM session_forks WHERE id = ?').get('fork-1'))
      .toEqual({ status: 'workspace_ready', workspace_snapshot_id: saga.intentId });
    expect(workspaceRepo.getSaga(saga.intentId)?.state).toBe('child_staged');

    workspaceRepo.finalizeSaga(saga.intentId, 43);

    expect(db.prepare('SELECT is_deleted, working_directory FROM sessions WHERE id = ?').get('child-1'))
      .toEqual({ is_deleted: 0, working_directory: '/durable/child-1' });
    expect(db.prepare('SELECT status, committed_at FROM session_forks WHERE id = ?').get('fork-1'))
      .toEqual({ status: 'completed', committed_at: 43 });
    expect(workspaceRepo.getSaga(saga.intentId)?.state).toBe('completed');
  });

  it('rolls back every child row when the staged child transaction fails', () => {
    const anchorEvidence = recordEvidence();
    const saga = workspaceRepo.beginSaga({
      sourceSessionId: 'source',
      anchorMessageId: 'a1',
      idempotencyKey: 'request-failure',
      requestDigest: 'request-failure-digest',
      evidenceId: anchorEvidence.id,
      proposedForkId: 'fork-failure',
      proposedChildSessionId: 'child-failure',
      contextDeliveryMode: 'neo_native_prefix',
      childTitle: 'Source · failed branch',
      now: 50,
    });
    workspaceRepo.markSagaWorkspaceReady(saga.intentId, '/durable/child-failure', 51);

    expect(() => workspaceRepo.stageChild(saga.intentId, () => {
      db.prepare(`
        INSERT INTO sessions (
          id, title, model_provider, model_name, created_at, updated_at, is_deleted
        ) VALUES ('child-failure', 'orphan', 'openai', 'gpt-5', 52, 52, 0)
      `).run();
      throw new Error('injected child commit failure');
    }, 52)).toThrow('injected child commit failure');

    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get('child-failure')).toBeUndefined();
    expect(db.prepare('SELECT id FROM session_forks WHERE id = ?').get('fork-failure')).toBeUndefined();
    expect(workspaceRepo.getSaga(saga.intentId)?.state).toBe('workspace_ready');
  });
});
