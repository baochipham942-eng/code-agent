import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AnchorEvidenceError,
  AnchorWorkspaceEvidenceService,
  NodeWorkspaceCommandRunner,
  type WorkspaceCommand,
  type WorkspaceCommandResult,
  type WorkspaceCommandRunner,
} from '../../../../src/host/services/sessionFork/workspace';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createRepository(): Promise<{ repositoryRoot: string; baseCommit: string }> {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'neo-anchor-evidence-'));
  temporaryDirectories.push(repositoryRoot);
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'tracked.txt'), 'base\n');
  await writeFile(path.join(repositoryRoot, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  return { repositoryRoot, baseCommit: git(repositoryRoot, 'rev-parse', 'HEAD') };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('AnchorWorkspaceEvidenceService', () => {
  it('captures explicit anchor state with binary-safe staged/unstaged patches and hashed untracked blobs', async () => {
    const { repositoryRoot, baseCommit } = await createRepository();
    await writeFile(path.join(repositoryRoot, 'src', 'tracked.txt'), 'staged\n');
    await writeFile(path.join(repositoryRoot, 'binary.dat'), Buffer.from([0, 255, 2, 3, 4]));
    git(repositoryRoot, 'add', 'src/tracked.txt', 'binary.dat');
    await writeFile(path.join(repositoryRoot, 'src', 'tracked.txt'), 'staged\nunstaged\n');
    const untrackedBytes = Buffer.from([222, 173, 0, 190, 239]);
    await writeFile(path.join(repositoryRoot, 'untracked.bin'), untrackedBytes);

    const service = new AnchorWorkspaceEvidenceService({
      runner: new NodeWorkspaceCommandRunner(),
      now: () => 1_726_000_000_000,
    });
    const evidence = await service.capture({
      anchorId: 'assistant-a2',
      repositoryRoot,
      baseCommit,
      workspaceScopeVersion: 'scope-v7',
      pathMappings: [{
        sourceId: 'source-primary',
        sourcePath: repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });

    expect(evidence.manifest.captureState).toBe('complete');
    expect(evidence.manifest.baseCommit).toBe(baseCommit);
    expect(evidence.manifest.baseCommitSource).toBe('explicit_anchor_input');
    expect(evidence.manifest.observedHead).toBe(baseCommit);
    expect(evidence.manifest.workspaceScopeVersion).toBe('scope-v7');
    expect(evidence.manifest.stagedPatch.sizeBytes).toBeGreaterThan(0);
    expect(evidence.manifest.unstagedPatch.sizeBytes).toBeGreaterThan(0);
    expect(Buffer.from(evidence.payload.stagedPatchBase64, 'base64').includes(Buffer.from('GIT binary patch')))
      .toBe(true);
    expect(evidence.manifest.untrackedFiles).toEqual([{
      path: 'untracked.bin',
      sha256: createHash('sha256').update(untrackedBytes).digest('hex'),
      sizeBytes: untrackedBytes.byteLength,
      mode: 0o644,
    }]);
    expect(Buffer.from(
      evidence.payload.untrackedBlobs[evidence.manifest.untrackedFiles[0].sha256],
      'base64',
    )).toEqual(untrackedBytes);

    await expect(service.validateBundle(evidence)).resolves.toBeUndefined();
    await expect(service.assertRepositoryIdentity(evidence, repositoryRoot)).resolves.toBeUndefined();
  });

  it('refuses capture without an explicit base commit or complete primary path mapping', async () => {
    const { repositoryRoot } = await createRepository();
    const service = new AnchorWorkspaceEvidenceService();

    await expect(service.capture({
      anchorId: 'assistant-a2',
      repositoryRoot,
      baseCommit: '',
      workspaceScopeVersion: 'scope-v1',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: repositoryRoot,
        isolatedRelativePath: '.',
      }],
    })).rejects.toMatchObject({ code: 'BASE_COMMIT_REQUIRED' } satisfies Partial<AnchorEvidenceError>);

    await expect(service.capture({
      anchorId: 'assistant-a2',
      repositoryRoot,
      baseCommit: 'deadbeef',
      workspaceScopeVersion: 'scope-v1',
      pathMappings: [],
    })).rejects.toMatchObject({ code: 'PATH_MAPPING_INCOMPLETE' } satisfies Partial<AnchorEvidenceError>);
  });

  it('refuses hidden tracked state and a repository generation that changes during capture', async () => {
    const { repositoryRoot, baseCommit } = await createRepository();
    const service = new AnchorWorkspaceEvidenceService();
    git(repositoryRoot, 'update-index', '--assume-unchanged', 'src/tracked.txt');
    await expect(service.capture({
      anchorId: 'assistant-a2',
      repositoryRoot,
      baseCommit,
      workspaceScopeVersion: 'scope-v1',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: repositoryRoot,
        isolatedRelativePath: '.',
      }],
    })).rejects.toMatchObject({ code: 'TRACKED_STATE_HIDDEN' } satisfies Partial<AnchorEvidenceError>);
    git(repositoryRoot, 'update-index', '--no-assume-unchanged', 'src/tracked.txt');

    class DriftingRunner implements WorkspaceCommandRunner {
      private stagedReads = 0;
      private readonly delegate = new NodeWorkspaceCommandRunner();

      async run(command: WorkspaceCommand): Promise<WorkspaceCommandResult> {
        const result = await this.delegate.run(command);
        if (command.args[0] === 'diff' && command.args.includes('--cached')) {
          this.stagedReads += 1;
          if (this.stagedReads === 2) {
            return { ...result, stdout: Buffer.concat([result.stdout, Buffer.from('\n')]) };
          }
        }
        return result;
      }
    }

    const drifting = new AnchorWorkspaceEvidenceService({ runner: new DriftingRunner() });
    await expect(drifting.capture({
      anchorId: 'assistant-a2',
      repositoryRoot,
      baseCommit,
      workspaceScopeVersion: 'scope-v1',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: repositoryRoot,
        isolatedRelativePath: '.',
      }],
    })).rejects.toMatchObject({ code: 'ANCHOR_STATE_CHANGED' } satisfies Partial<AnchorEvidenceError>);
  });

  it('fails closed when patch/blob evidence is missing or tampered', async () => {
    const { repositoryRoot, baseCommit } = await createRepository();
    await writeFile(path.join(repositoryRoot, 'untracked.txt'), 'anchor-only');
    const service = new AnchorWorkspaceEvidenceService();
    const evidence = await service.capture({
      anchorId: 'assistant-a2',
      repositoryRoot,
      baseCommit,
      workspaceScopeVersion: 'scope-v1',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });

    const missingBlob = structuredClone(evidence);
    missingBlob.payload.untrackedBlobs = {};
    await expect(service.validateBundle(missingBlob))
      .rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' } satisfies Partial<AnchorEvidenceError>);

    const tamperedPatch = structuredClone(evidence);
    tamperedPatch.payload.unstagedPatchBase64 = Buffer.from('tampered').toString('base64');
    await expect(service.validateBundle(tamperedPatch))
      .rejects.toMatchObject({ code: 'EVIDENCE_HASH_MISMATCH' } satisfies Partial<AnchorEvidenceError>);
  });

  it('rejects repository identity drift before materialization can trust the evidence', async () => {
    const first = await createRepository();
    const second = await createRepository();
    const service = new AnchorWorkspaceEvidenceService();
    const evidence = await service.capture({
      anchorId: 'assistant-a2',
      repositoryRoot: first.repositoryRoot,
      baseCommit: first.baseCommit,
      workspaceScopeVersion: 'scope-v1',
      pathMappings: [{
        sourceId: 'primary',
        sourcePath: first.repositoryRoot,
        isolatedRelativePath: '.',
      }],
    });

    await expect(service.assertRepositoryIdentity(evidence, second.repositoryRoot))
      .rejects.toMatchObject({ code: 'REPOSITORY_IDENTITY_DRIFT' } satisfies Partial<AnchorEvidenceError>);

    expect(await readFile(path.join(first.repositoryRoot, 'src', 'tracked.txt'), 'utf8')).toBe('base\n');
  });
});
