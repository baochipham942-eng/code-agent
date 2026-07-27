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
import { IsolatedAnchorWorkspaceService } from '../../../../src/host/services/sessionFork/workspace';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createFixture(): Promise<{
  root: string;
  repositoryRoot: string;
  dbPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-advertised-recovery-'));
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

describe('DatabaseService advertised workspace restart recovery', () => {
  it('keeps the staged child hidden when finalize fails after workspace advertisement', async () => {
    const setup = await createFixture();
    const database = await initializedDatabase(setup.dbPath);
    try {
      seedConversation(database, setup.repositoryRoot);
      await writeFile(path.join(setup.repositoryRoot, 'tracked.txt'), 'anchor state\n');
      await database.captureSessionForkAnchorEvidence('source', 'a1');
      const workspaceRepo = (
        database as unknown as { sessionForkWorkspaceRepo: SessionForkWorkspaceRepository }
      ).sessionForkWorkspaceRepo;
      vi.spyOn(workspaceRepo, 'finalizeSaga').mockImplementation(() => {
        throw new Error('injected finalize failure');
      });

      await expect(database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'finalize-failure',
        ownerUserId: 'owner',
        forkId: 'fork-finalize-failure',
        childSessionId: 'child-finalize-failure',
        childTitle: 'Source · finalize failure',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 90,
      })).rejects.toMatchObject({ code: 'FORK_OPERATION_FAILED' });

      expect(database.getSession('child-finalize-failure', { userId: 'owner' })).toBeNull();
      expect(database.getDb()?.prepare(`
        SELECT is_deleted FROM sessions WHERE id = 'child-finalize-failure'
      `).get()).toEqual({ is_deleted: 1 });
      expect(database.getDb()?.prepare(`
        SELECT state FROM session_fork_workspace_sagas
        WHERE source_session_id = 'source' AND idempotency_key = 'finalize-failure'
      `).get()).toEqual({ state: 'quarantined' });
      expect(database.getDb()?.prepare(`
        SELECT status, advertisable FROM session_fork_workspace_intents
        WHERE source_session_id = 'source'
        ORDER BY created_at DESC LIMIT 1
      `).get()).toEqual({ status: 'abandoned', advertisable: 0 });
      expect(git(setup.repositoryRoot, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('keeps completed idempotent retries compatible after the child workspace evolves', async () => {
    const setup = await createFixture();
    const database = await initializedDatabase(setup.dbPath);
    try {
      seedConversation(database, setup.repositoryRoot);
      await writeFile(path.join(setup.repositoryRoot, 'tracked.txt'), 'anchor state\n');
      await database.captureSessionForkAnchorEvidence('source', 'a1');
      const first = await database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'completed-retry',
        ownerUserId: 'owner',
        forkId: 'fork-completed-retry',
        childSessionId: 'child-completed-retry',
        childTitle: 'Source · completed retry',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 100,
      });
      const child = database.getSession(first.childSessionId, { userId: 'owner' });
      if (!child?.workingDirectory) throw new Error('completed child has no workspace');
      await writeFile(path.join(child.workingDirectory, 'tracked.txt'), 'legitimate child evolution\n');

      const repeated = await database.createIsolatedSessionFork({
        sourceSessionId: 'source',
        anchorAssistantMessageId: 'a1',
        idempotencyKey: 'completed-retry',
        ownerUserId: 'owner',
        forkId: 'ignored-fork-id',
        childSessionId: 'ignored-child-id',
        childTitle: 'Source · completed retry',
        workspaceMode: 'isolated_at_anchor',
        contextDeliveryMode: 'neo_native_prefix',
        now: 101,
      });

      expect(repeated).toEqual(first);
      expect(await readFile(path.join(child.workingDirectory, 'tracked.txt'), 'utf8'))
        .toBe('legitimate child evolution\n');
      expect(database.getSession(first.childSessionId, { userId: 'owner' })).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it('quarantines and keeps the child hidden when the anchor seal drifts before finalize', async () => {
    const setup = await createFixture();
    const firstDatabase = await initializedDatabase(setup.dbPath);
    seedConversation(firstDatabase, setup.repositoryRoot);
    await writeFile(path.join(setup.repositoryRoot, 'tracked.txt'), 'anchor state\n');
    const sourceBytesBefore = await readFile(path.join(setup.repositoryRoot, 'tracked.txt'));
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
      idempotencyKey: 'advertised-crash',
      requestDigest: 'advertised-crash-digest',
      evidenceId: anchorEvidence.id,
      proposedForkId: 'fork-advertised-crash',
      proposedChildSessionId: 'child-advertised-crash',
      contextDeliveryMode: 'neo_native_prefix',
      childTitle: 'Source · advertised crash',
      now: 200,
    });
    const workspaceService = new IsolatedAnchorWorkspaceService({
      durableRoot: path.join(path.dirname(setup.dbPath), 'session-fork-worktrees'),
      intentStore: workspaceRepo,
    });
    const prepared = await workspaceService.prepare({
      intentId: saga.intentId,
      sourceSessionId: 'source',
      proposedChildSessionId: 'child-advertised-crash',
      repositoryRoot: anchorEvidence.repositoryRoot,
      destinationName: 'child-advertised-crash',
      evidence: anchorEvidence.evidence,
    });
    workspaceRepo.markSagaWorkspaceReady(saga.intentId, prepared.workspacePath, 201);
    workspaceRepo.stageChild(saga.intentId, (current) => forkRepo.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a1',
      idempotencyKey: 'advertised-crash',
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
    await workspaceService.markAdvertised(saga.intentId);
    firstDatabase.close();

    await writeFile(path.join(prepared.workspacePath, 'tracked.txt'), 'drifted before finalize\n');

    const restarted = await initializedDatabase(setup.dbPath);
    try {
      expect(restarted.getSession('child-advertised-crash', { userId: 'owner' })).toBeNull();
      expect(restarted.getDb()?.prepare(`
        SELECT is_deleted FROM sessions WHERE id = 'child-advertised-crash'
      `).get()).toEqual({ is_deleted: 1 });
      expect(restarted.getDb()?.prepare(`
        SELECT state, child_session_id
        FROM session_fork_workspace_sagas
        WHERE intent_id = ?
      `).get(saga.intentId)).toEqual({
        state: 'quarantined',
        child_session_id: 'child-advertised-crash',
      });
      expect(restarted.getDb()?.prepare(`
        SELECT status, committed_at
        FROM session_forks
        WHERE id = 'fork-advertised-crash'
      `).get()).toEqual({
        status: 'quarantined',
        committed_at: null,
      });
      expect(restarted.getDb()?.prepare(`
        SELECT status, advertisable
        FROM session_fork_workspace_intents
        WHERE intent_id = ?
      `).get(saga.intentId)).toEqual({
        status: 'abandoned',
        advertisable: 0,
      });
      await expect(readFile(path.join(prepared.workspacePath, 'tracked.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(git(setup.repositoryRoot, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))).toHaveLength(1);
      expect(await readFile(path.join(setup.repositoryRoot, 'tracked.txt'))).toEqual(sourceBytesBefore);
    } finally {
      restarted.close();
    }
  });
});
