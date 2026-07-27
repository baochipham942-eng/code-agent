import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
vi.mock('../../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return {
    loadBetterSqlite3: () => module.default,
  };
});

const projectState = vi.hoisted(() => ({
  scope: undefined as undefined | {
    projectId: string;
    primaryRoot: string;
    version: string;
    roots: Array<{
      sourceId: string;
      path: string;
      access: 'read_write';
      role: 'primary';
      identityDev: string;
      identityIno: string;
    }>;
  },
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    getWorkspaceScope: () => projectState.scope,
  }),
}));

import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import { SessionForkRepository } from '../../../../src/host/services/core/repositories/SessionForkRepository';
import { SessionForkWorkspaceRepository } from '../../../../src/host/services/core/repositories/SessionForkWorkspaceRepository';
import {
  IsolatedAnchorWorkspaceService,
} from '../../../../src/host/services/sessionFork/workspace';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function fixture(): Promise<{
  root: string;
  repositoryRoot: string;
  dbPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-database-workspace-saga-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  await mkdir(repositoryRoot);
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const identity = await stat(repositoryRoot);
  projectState.scope = {
    projectId: 'project-1',
    primaryRoot: repositoryRoot,
    version: 'scope-v1',
    roots: [{
      sourceId: 'source-primary',
      path: repositoryRoot,
      access: 'read_write',
      role: 'primary',
      identityDev: String(identity.dev),
      identityIno: String(identity.ino),
    }],
  };
  return {
    root,
    repositoryRoot,
    dbPath: path.join(root, 'data', 'code-agent.db'),
  };
}

async function initializedDatabase(dbPath: string): Promise<DatabaseService> {
  const database = new DatabaseService();
  (database as unknown as { dbPath: string }).dbPath = dbPath;
  await database.initialize();
  return database;
}

function seedConversation(database: DatabaseService, repositoryRoot: string): void {
  database.createSession({
    id: 'source',
    userId: 'owner',
    title: 'Source',
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    workingDirectory: repositoryRoot,
    projectId: 'project-1',
    engine: { kind: 'native', model: 'gpt-5', cwd: repositoryRoot },
    status: 'completed',
    createdAt: 1,
    updatedAt: 1,
  });
  database.getDb()?.prepare(`
    UPDATE sessions SET project_id = 'project-1' WHERE id = 'source'
  `).run();
  database.addMessage('source', {
    id: 'u1',
    role: 'user',
    content: 'question',
    timestamp: 10,
  });
  database.addMessage('source', {
    id: 'a1',
    role: 'assistant',
    content: 'answer',
    timestamp: 20,
  });
}

afterEach(async () => {
  projectState.scope = undefined;
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('DatabaseService isolated_at_anchor workspace saga', () => {
  it('captures the anchor HEAD and publishes one idempotent child at the durable reconstructed cwd', async () => {
    const setup = await fixture();
    const database = await initializedDatabase(setup.dbPath);
    try {
      seedConversation(database, setup.repositoryRoot);
      await writeFile(path.join(setup.repositoryRoot, 'tracked.txt'), 'anchor staged\n');
      git(setup.repositoryRoot, 'add', 'tracked.txt');
      await writeFile(path.join(setup.repositoryRoot, 'tracked.txt'), 'anchor staged\nanchor unstaged\n');
      await writeFile(path.join(setup.repositoryRoot, 'untracked.txt'), 'anchor untracked\n');
      const sourceStatusBefore = git(setup.repositoryRoot, 'status', '--porcelain=v1', '-z');
      const sourceTrackedBefore = await readFile(path.join(setup.repositoryRoot, 'tracked.txt'));
      const sourceUntrackedBefore = await readFile(path.join(setup.repositoryRoot, 'untracked.txt'));

      const anchorEvidence = await database.captureSessionForkAnchorEvidence('source', 'a1');
      expect(anchorEvidence).toMatchObject({
        status: 'complete',
        projectId: 'project-1',
        workspaceScopeVersion: 'scope-v1',
        baseCommit: git(setup.repositoryRoot, 'rev-parse', 'HEAD'),
        observedHead: git(setup.repositoryRoot, 'rev-parse', 'HEAD'),
      });

      const first = await database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'isolated-request',
        ownerUserId: 'owner',
        forkId: 'fork-first',
        childSessionId: 'child-first',
        childTitle: 'Source · branch',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 100,
      });
      const repeated = await database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'isolated-request',
        ownerUserId: 'owner',
        forkId: 'fork-ignored-on-retry',
        childSessionId: 'child-ignored-on-retry',
        childTitle: 'Source · branch',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 101,
      });

      expect(repeated.childSessionId).toBe(first.childSessionId);
      const child = database.getSession(first.childSessionId, { userId: 'owner' });
      expect(child?.workingDirectory).toBe(path.join(
        path.dirname(setup.dbPath),
        'session-fork-worktrees',
        first.childSessionId,
      ));
      expect(child?.engine).toMatchObject({
        kind: 'native',
        cwd: child?.workingDirectory,
      });
      expect(await readFile(path.join(child?.workingDirectory ?? '', 'tracked.txt'), 'utf8'))
        .toBe('anchor staged\nanchor unstaged\n');
      expect(await readFile(path.join(child?.workingDirectory ?? '', 'untracked.txt'), 'utf8'))
        .toBe('anchor untracked\n');
      expect(git(setup.repositoryRoot, 'status', '--porcelain=v1', '-z')).toBe(sourceStatusBefore);
      expect(await readFile(path.join(setup.repositoryRoot, 'tracked.txt'))).toEqual(sourceTrackedBefore);
      expect(await readFile(path.join(setup.repositoryRoot, 'untracked.txt'))).toEqual(sourceUntrackedBefore);
      expect(database.getDb()?.prepare(`
        SELECT COUNT(*) AS count FROM session_forks
        WHERE source_session_id = 'source' AND idempotency_key = 'isolated-request'
      `).get()).toEqual({ count: 1 });
      expect(git(setup.repositoryRoot, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))).toHaveLength(2);
      expect(database.getDb()?.prepare(`
        SELECT status, workspace_snapshot_id FROM session_forks WHERE id = ?
      `).get(first.forkId)).toEqual({
        status: 'completed',
        workspace_snapshot_id: expect.stringMatching(/^workspace_intent_/),
      });
      expect(database.getSessionForkWorkspaceScope(first.childSessionId, 'owner')).toEqual({
        projectId: 'project-1',
        primaryRoot: child?.workingDirectory,
        roots: [{
          sourceId: expect.stringMatching(/^isolated:workspace_intent_/),
          path: child?.workingDirectory,
          access: 'read_only',
          role: 'primary',
        }],
        version: expect.stringMatching(/^isolated-v1:workspace_intent_/),
      });
      expect(database.getSessionForkWorkspaceScope('source', 'owner')).toBeNull();
      expect(() => database.getSessionForkWorkspaceScope(first.childSessionId, 'other-owner'))
        .toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));

      const metadataRow = database.getDb()?.prepare(`
        SELECT metadata FROM sessions WHERE id = ?
      `).get(first.childSessionId) as { metadata: string };
      const tamperedMetadata = JSON.parse(metadataRow.metadata);
      tamperedMetadata.forkWorkspaceScopeV1.evidenceDigest = '0'.repeat(64);
      database.getDb()?.prepare(`
        UPDATE sessions SET metadata = ? WHERE id = ?
      `).run(JSON.stringify(tamperedMetadata), first.childSessionId);
      expect(() => database.getSessionForkWorkspaceScope(first.childSessionId, 'owner'))
        .toThrowError(expect.objectContaining({ code: 'WORKSPACE_IDENTITY_DRIFT' }));
    } finally {
      database.close();
    }
  });

  it('recovers a crash after child staging and exposes the child only after restart verification', async () => {
    const setup = await fixture();
    const firstDatabase = await initializedDatabase(setup.dbPath);
    seedConversation(firstDatabase, setup.repositoryRoot);
    await writeFile(path.join(setup.repositoryRoot, 'tracked.txt'), 'anchor state\n');
    const anchorEvidence = await firstDatabase.captureSessionForkAnchorEvidence('source', 'a1');
    if (!anchorEvidence?.evidence || !anchorEvidence.repositoryRoot) {
      throw new Error('test anchor evidence was not captured');
    }

    const raw = firstDatabase.getDb();
    if (!raw) throw new Error('test database was not initialized');
    const workspaceRepo = new SessionForkWorkspaceRepository(raw);
    const forkRepo = new SessionForkRepository(raw);
    const saga = workspaceRepo.beginSaga({
      sourceSessionId: 'source',
      anchorMessageId: 'a1',
      idempotencyKey: 'restart-request',
      requestDigest: 'restart-request-digest',
      evidenceId: anchorEvidence.id,
      proposedForkId: 'fork-restart',
      proposedChildSessionId: 'child-restart',
      contextDeliveryMode: 'neo_native_prefix',
      childTitle: 'Source · recovered branch',
      now: 200,
    });
    const workspaceService = new IsolatedAnchorWorkspaceService({
      durableRoot: path.join(path.dirname(setup.dbPath), 'session-fork-worktrees'),
      intentStore: workspaceRepo,
    });
    const prepared = await workspaceService.prepare({
      intentId: saga.intentId,
      sourceSessionId: 'source',
      proposedChildSessionId: 'child-restart',
      repositoryRoot: anchorEvidence.repositoryRoot,
      destinationName: 'child-restart',
      evidence: anchorEvidence.evidence,
    });
    workspaceRepo.markSagaWorkspaceReady(saga.intentId, prepared.workspacePath, 201);
    workspaceRepo.stageChild(saga.intentId, (current) => forkRepo.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a1',
      idempotencyKey: 'restart-request',
      ownerUserId: 'owner',
      forkId: current.proposedForkId,
      childSessionId: current.proposedChildSessionId,
      childTitle: current.childTitle,
      workspaceMode: 'isolated_at_anchor',
      contextDeliveryMode: 'neo_native_prefix',
      childWorkingDirectory: prepared.workspacePath,
      workspaceSnapshotId: current.intentId,
      now: 202,
    }), 202);

    expect(firstDatabase.getSession('child-restart', { userId: 'owner' })).toBeNull();
    firstDatabase.close();

    const restarted = await initializedDatabase(setup.dbPath);
    try {
      expect(restarted.getSession('child-restart', { userId: 'owner' })).toMatchObject({
        id: 'child-restart',
        workingDirectory: prepared.workspacePath,
      });
      expect(restarted.getDb()?.prepare(`
        SELECT state FROM session_fork_workspace_sagas WHERE intent_id = ?
      `).get(saga.intentId)).toEqual({ state: 'completed' });
      expect(restarted.getDb()?.prepare(`
        SELECT status, advertisable FROM session_fork_workspace_intents WHERE intent_id = ?
      `).get(saga.intentId)).toEqual({ status: 'advertised', advertisable: 1 });
      expect(restarted.getDb()?.prepare(`
        SELECT status FROM session_forks WHERE id = 'fork-restart'
      `).get()).toEqual({ status: 'completed' });
      expect(restarted.getSessionForkWorkspaceScope('child-restart', 'owner')?.primaryRoot)
        .toBe(prepared.workspacePath);
      restarted.getDb()?.prepare(`
        UPDATE session_fork_workspace_sagas SET state = 'quarantined' WHERE intent_id = ?
      `).run(saga.intentId);
      expect(() => restarted.getSessionForkWorkspaceScope('child-restart', 'owner'))
        .toThrowError(expect.objectContaining({ code: 'WORKSPACE_IDENTITY_DRIFT' }));
    } finally {
      restarted.close();
    }
  });

  it('leaves zero child rows when worktree preparation fails', async () => {
    const setup = await fixture();
    const database = await initializedDatabase(setup.dbPath);
    try {
      seedConversation(database, setup.repositoryRoot);
      await database.captureSessionForkAnchorEvidence('source', 'a1');
      Object.assign(database as unknown as Record<string, unknown>, {
        isolatedAnchorWorkspaceService: {
          prepare: vi.fn(async () => {
            throw Object.assign(new Error('injected worktree failure'), {
              code: 'WORKSPACE_PREPARATION_FAILED',
            });
          }),
          recoverIntent: vi.fn(async () => ({
            intentId: 'unknown',
            outcome: 'cleaned',
            workspacePath: '',
          })),
        },
      });

      await expect(database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'worktree-failure',
        ownerUserId: 'owner',
        forkId: 'fork-failure',
        childSessionId: 'child-failure',
        childTitle: 'Source · failed',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 300,
      })).rejects.toMatchObject({ code: 'FORK_OPERATION_FAILED' });

      expect(database.getDb()?.prepare(`
        SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-failure'
      `).get()).toEqual({ count: 0 });
      expect(database.getDb()?.prepare(`
        SELECT state FROM session_fork_workspace_sagas
        WHERE source_session_id = 'source' AND idempotency_key = 'worktree-failure'
      `).get()).toEqual({ state: 'aborted' });
    } finally {
      database.close();
    }
  });

  it('records multi-source evidence as blocked and rejects the isolated fork with zero child writes', async () => {
    const setup = await fixture();
    const database = await initializedDatabase(setup.dbPath);
    try {
      seedConversation(database, setup.repositoryRoot);
      const secondRoot = path.join(setup.root, 'second-source');
      await mkdir(secondRoot);
      const secondIdentity = await stat(secondRoot);
      projectState.scope?.roots.push({
        sourceId: 'source-secondary',
        path: secondRoot,
        access: 'read_write',
        role: 'primary',
        identityDev: String(secondIdentity.dev),
        identityIno: String(secondIdentity.ino),
      });
      if (projectState.scope) projectState.scope.version = 'scope-v2';

      const blocked = await database.captureSessionForkAnchorEvidence('source', 'a1');
      expect(blocked).toMatchObject({
        status: 'blocked',
        workspaceScopeVersion: 'scope-v2',
        blockedReason: expect.stringContaining('MULTI_SOURCE_ATOMIC_RECONSTRUCTION_UNSUPPORTED'),
      });

      await expect(database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'multi-source',
        ownerUserId: 'owner',
        forkId: 'fork-multi',
        childSessionId: 'child-multi',
        childTitle: 'Source · multi',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 400,
      })).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
      expect(database.getDb()?.prepare(`
        SELECT COUNT(*) AS count FROM sessions WHERE id = 'child-multi'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rejects an anchor whose persisted message bytes changed after evidence capture', async () => {
    const setup = await fixture();
    const database = await initializedDatabase(setup.dbPath);
    try {
      seedConversation(database, setup.repositoryRoot);
      await database.captureSessionForkAnchorEvidence('source', 'a1');
      database.updateMessage('a1', { content: 'tampered after evidence capture' }, 'source');

      await expect(database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'tampered-anchor',
        ownerUserId: 'owner',
        forkId: 'fork-tampered',
        childSessionId: 'child-tampered',
        childTitle: 'Source · tampered',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 500,
      })).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
      expect(database.getDb()?.prepare(`
        SELECT COUNT(*) AS count FROM session_fork_workspace_sagas
        WHERE idempotency_key = 'tampered-anchor'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
