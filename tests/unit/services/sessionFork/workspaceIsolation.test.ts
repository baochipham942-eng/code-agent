import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AnchorWorkspaceEvidenceService,
  IsolatedAnchorWorkspaceService,
  JsonWorkspaceForkIntentStore,
  NodeWorkspaceCommandRunner,
  WorkspaceCommandError,
  type WorkspaceCommand,
  type WorkspaceCommandResult,
  type WorkspaceCommandRunner,
} from '../../../../src/host/services/sessionFork/workspace';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createAnchorFixture(): Promise<{
  repositoryRoot: string;
  baseCommit: string;
  durableRoot: string;
  stateDirectory: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-isolated-anchor-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  const durableRoot = path.join(root, 'durable-workspaces');
  const stateDirectory = path.join(root, 'intent-state');
  await mkdir(repositoryRoot, { recursive: true });
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  await writeFile(path.join(repositoryRoot, 'binary.dat'), Buffer.from([0, 1, 2]));
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');

  await writeFile(path.join(repositoryRoot, 'committed-after-base.txt'), 'captured after explicit base\n');
  git(repositoryRoot, 'add', 'committed-after-base.txt');
  git(repositoryRoot, 'commit', '-m', 'advance head before anchor capture');

  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'anchor staged\n');
  await writeFile(path.join(repositoryRoot, 'binary.dat'), Buffer.from([0, 255, 2, 7]));
  git(repositoryRoot, 'add', 'tracked.txt', 'binary.dat');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'anchor staged\nanchor unstaged\n');
  await writeFile(path.join(repositoryRoot, 'new.bin'), Buffer.from([9, 0, 8, 7]));

  return { repositoryRoot, baseCommit, durableRoot, stateDirectory };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

class FailOnceRunner implements WorkspaceCommandRunner {
  private failed = false;

  constructor(
    private readonly delegate: WorkspaceCommandRunner,
    private readonly shouldFail: (command: WorkspaceCommand) => boolean,
  ) {}

  async run(command: WorkspaceCommand): Promise<WorkspaceCommandResult> {
    if (!this.failed && this.shouldFail(command)) {
      this.failed = true;
      throw new WorkspaceCommandError('INJECTED_FAILURE', command, 'injected command failure');
    }
    return this.delegate.run(command);
  }
}

describe('IsolatedAnchorWorkspaceService', () => {
  it('fails closed when the public workspace root is replaced at the staged publish barrier', async () => {
    const fixture = await createAnchorFixture();
    await mkdir(path.join(fixture.repositoryRoot, 'nested'), { recursive: true });
    await writeFile(path.join(fixture.repositoryRoot, 'nested', 'race.bin'), Buffer.from([7, 0, 6, 5]));
    const evidenceService = new AnchorWorkspaceEvidenceService();
    const evidence = await evidenceService.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: fixture.repositoryRoot,
      baseCommit: fixture.baseCommit,
      workspaceScopeVersion: 'scope-v3',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: fixture.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });
    const sourceStatusBefore = git(fixture.repositoryRoot, 'status', '--porcelain=v1', '-z');
    const sourceRaceTarget = path.join(fixture.repositoryRoot, 'race.bin');
    const intentStore = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const service = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore,
      workspacePublishBarrier: async (input) => {
        expect(await readFile(path.join(input.stagingWorkspacePath, 'nested', 'race.bin')))
          .toEqual(Buffer.from([7, 0, 6, 5]));
        await symlink(fixture.repositoryRoot, input.workspacePath, 'dir');
      },
    });

    await expect(service.prepare({
      intentId: 'ancestor-symlink-race',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'ancestor-symlink-race',
      evidence,
    })).rejects.toMatchObject({ code: 'WORKSPACE_PREPARATION_FAILED' });

    await expect(readFile(sourceRaceTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(fixture.repositoryRoot, 'status', '--porcelain=v1', '-z')).toBe(sourceStatusBefore);
    expect(await intentStore.get('ancestor-symlink-race')).toMatchObject({
      status: 'cleanup_required',
      advertisable: false,
    });
  });

  it('reconstructs the explicitly captured anchor into a durable detached worktree', async () => {
    const fixture = await createAnchorFixture();
    const quotedBinaryPath = path.join(fixture.repositoryRoot, 'nested dir', 'utf8-你好.bin');
    await mkdir(path.dirname(quotedBinaryPath), { recursive: true });
    const quotedBinary = Buffer.from(Array.from({ length: 80 }, (_, index) => (index * 31) % 256));
    await writeFile(quotedBinaryPath, quotedBinary);
    await chmod(quotedBinaryPath, 0o600);
    await writeFile(path.join(fixture.repositoryRoot, 'empty.dat'), Buffer.alloc(0));
    const evidenceService = new AnchorWorkspaceEvidenceService();
    const evidence = await evidenceService.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: fixture.repositoryRoot,
      baseCommit: fixture.baseCommit,
      workspaceScopeVersion: 'scope-v3',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: fixture.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });
    const sourceStatusBefore = git(fixture.repositoryRoot, 'status', '--porcelain=v1', '-z');
    const intentStore = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const service = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore,
    });

    const prepareInput = {
      intentId: 'fork-intent-1',
      sourceSessionId: 'parent-session',
      proposedChildSessionId: 'child-session',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'child-session',
      evidence,
    };
    const [prepared, repeated] = await Promise.all([
      service.prepare(prepareInput),
      service.prepare(prepareInput),
    ]);

    expect(prepared.status).toBe('ready');
    expect(repeated).toEqual(prepared);
    expect(prepared.advertisable).toBe(true);
    expect(prepared.workspacePath).toBe(path.join(fixture.durableRoot, 'child-session'));
    expect(git(prepared.workspacePath, 'rev-parse', 'HEAD')).toBe(fixture.baseCommit);
    expect(git(prepared.workspacePath, 'branch', '--show-current')).toBe('');
    expect(evidence.manifest.observedHead).not.toBe(evidence.manifest.baseCommit);
    expect(await readFile(path.join(prepared.workspacePath, 'committed-after-base.txt'), 'utf8'))
      .toBe('captured after explicit base\n');
    expect(await readFile(path.join(prepared.workspacePath, 'tracked.txt'), 'utf8'))
      .toBe('anchor staged\nanchor unstaged\n');
    expect(await readFile(path.join(prepared.workspacePath, 'binary.dat')))
      .toEqual(Buffer.from([0, 255, 2, 7]));
    expect(await readFile(path.join(prepared.workspacePath, 'new.bin')))
      .toEqual(Buffer.from([9, 0, 8, 7]));
    expect(await readFile(path.join(prepared.workspacePath, 'nested dir', 'utf8-你好.bin')))
      .toEqual(quotedBinary);
    expect((await stat(path.join(prepared.workspacePath, 'nested dir', 'utf8-你好.bin'))).mode & 0o777)
      .toBe(0o600);
    expect(await readFile(path.join(prepared.workspacePath, 'empty.dat')))
      .toEqual(Buffer.alloc(0));
    expect(git(fixture.repositoryRoot, 'status', '--porcelain=v1', '-z')).toBe(sourceStatusBefore);

    const persisted = await intentStore.get('fork-intent-1');
    expect(persisted).toMatchObject({
      status: 'ready',
      attempts: 1,
      sourceSessionId: 'parent-session',
      proposedChildSessionId: 'child-session',
      workspacePath: prepared.workspacePath,
    });

    await expect(service.prepare({
      ...prepareInput,
      intentId: 'conflicting-intent',
      proposedChildSessionId: 'another-child',
    })).rejects.toMatchObject({ code: 'INTENT_CONFLICT' });
    expect((await intentStore.get('fork-intent-1'))?.status).toBe('ready');

    await writeFile(path.join(prepared.workspacePath, 'tracked.txt'), 'drifted after ready\n');
    await expect(service.prepare(prepareInput))
      .rejects.toMatchObject({ code: 'WORKSPACE_VERIFICATION_FAILED' });
    expect(await intentStore.get('fork-intent-1')).toMatchObject({
      status: 'cleanup_required',
      advertisable: false,
    });
  });

  it('rejects identity drift and incomplete evidence before creating an intent or worktree', async () => {
    const fixture = await createAnchorFixture();
    const other = await createAnchorFixture();
    const evidenceService = new AnchorWorkspaceEvidenceService();
    const evidence = await evidenceService.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: fixture.repositoryRoot,
      baseCommit: fixture.baseCommit,
      workspaceScopeVersion: 'scope-v3',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: fixture.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });
    const intentStore = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const service = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore,
    });

    await expect(service.prepare({
      intentId: 'identity-drift',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      repositoryRoot: other.repositoryRoot,
      destinationName: 'child',
      evidence,
    })).rejects.toMatchObject({ code: 'REPOSITORY_IDENTITY_DRIFT' });
    expect(await intentStore.list()).toEqual([]);

    const incomplete = structuredClone(evidence);
    incomplete.payload.untrackedBlobs = {};
    await expect(service.prepare({
      intentId: 'incomplete',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'child',
      evidence: incomplete,
    })).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
    expect(await intentStore.list()).toEqual([]);
  });

  it('does not advertise a child on failure and resumes the durable intent after restart', async () => {
    const fixture = await createAnchorFixture();
    const realRunner = new NodeWorkspaceCommandRunner();
    const evidenceService = new AnchorWorkspaceEvidenceService({ runner: realRunner });
    const evidence = await evidenceService.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: fixture.repositoryRoot,
      baseCommit: fixture.baseCommit,
      workspaceScopeVersion: 'scope-v3',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: fixture.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });
    const firstStore = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const failingService = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: firstStore,
      runner: new FailOnceRunner(
        realRunner,
        (command) => command.executable === 'git' && command.args[0] === 'apply',
      ),
    });

    await expect(failingService.prepare({
      intentId: 'restartable-intent',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'restartable-child',
      evidence,
    })).rejects.toMatchObject({ code: 'WORKSPACE_PREPARATION_FAILED' });

    const failed = await firstStore.get('restartable-intent');
    expect(failed?.advertisable).toBe(false);
    expect(failed?.status).toBe('cleanup_required');

    const restartedStore = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const restartedService = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: restartedStore,
      runner: realRunner,
    });
    const recovered = await restartedService.recoverIncomplete({ strategy: 'resume' });

    expect(recovered).toEqual([expect.objectContaining({
      intentId: 'restartable-intent',
      outcome: 'ready',
    })]);
    expect((await restartedStore.get('restartable-intent'))?.status).toBe('ready');
    expect(await readFile(path.join(fixture.durableRoot, 'restartable-child', 'tracked.txt'), 'utf8'))
      .toBe('anchor staged\nanchor unstaged\n');
  });

  it('can clean incomplete intents after restart without touching a ready workspace', async () => {
    const fixture = await createAnchorFixture();
    const realRunner = new NodeWorkspaceCommandRunner();
    const evidenceService = new AnchorWorkspaceEvidenceService({ runner: realRunner });
    const evidence = await evidenceService.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: fixture.repositoryRoot,
      baseCommit: fixture.baseCommit,
      workspaceScopeVersion: 'scope-v3',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: fixture.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });
    const store = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const readyService = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: store,
      runner: realRunner,
    });
    const ready = await readyService.prepare({
      intentId: 'ready-intent',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'ready-child',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'ready-child',
      evidence,
    });
    await readyService.markAdvertised('ready-intent');
    await writeFile(path.join(ready.workspacePath, 'tracked.txt'), 'child evolved after advertisement\n');
    const failingService = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: store,
      runner: new FailOnceRunner(realRunner, (command) => command.args[0] === 'apply'),
    });
    await expect(failingService.prepare({
      intentId: 'cleanup-intent',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'cleanup-child',
      evidence,
    })).rejects.toBeDefined();

    const restarted = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: new JsonWorkspaceForkIntentStore(fixture.stateDirectory),
      runner: realRunner,
    });
    const results = await restarted.recoverIncomplete({ strategy: 'cleanup' });

    expect(results).toEqual([expect.objectContaining({
      intentId: 'cleanup-intent',
      outcome: 'cleaned',
    })]);
    expect((await store.get('cleanup-intent'))?.status).toBe('abandoned');
    expect((await store.get('ready-intent'))?.status).toBe('advertised');
    expect(await readFile(path.join(ready.workspacePath, 'tracked.txt'), 'utf8'))
      .toBe('child evolved after advertisement\n');
    await expect(readFile(path.join(fixture.durableRoot, 'cleanup-child', 'tracked.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-verifies an advertised-but-unfinalized workspace during restart recovery', async () => {
    const fixture = await createAnchorFixture();
    const evidenceService = new AnchorWorkspaceEvidenceService();
    const evidence = await evidenceService.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: fixture.repositoryRoot,
      baseCommit: fixture.baseCommit,
      workspaceScopeVersion: 'scope-v3',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: fixture.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });
    const firstStore = new JsonWorkspaceForkIntentStore(fixture.stateDirectory);
    const firstService = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: firstStore,
    });
    const prepared = await firstService.prepare({
      intentId: 'advertised-crash-window',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      repositoryRoot: fixture.repositoryRoot,
      destinationName: 'advertised-crash-window',
      evidence,
    });
    await firstService.markAdvertised('advertised-crash-window');
    await writeFile(path.join(prepared.workspacePath, 'tracked.txt'), 'drifted before finalize\n');

    const restartedService = new IsolatedAnchorWorkspaceService({
      durableRoot: fixture.durableRoot,
      intentStore: new JsonWorkspaceForkIntentStore(fixture.stateDirectory),
    });
    const recovery = await restartedService.recoverIntent(
      'advertised-crash-window',
      { strategy: 'resume' },
    );

    expect(recovery).toMatchObject({
      intentId: 'advertised-crash-window',
      outcome: 'failed',
      workspacePath: prepared.workspacePath,
    });
    expect(recovery.error).toContain('differs from anchor evidence');
  });
});
