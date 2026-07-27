import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnchorWorkspaceEvidenceService,
  ImportedPortableAnchorWorkspaceMaterializer,
  IsolatedAnchorWorkspaceService,
  JsonWorkspaceForkIntentStore,
} from '../../../../src/host/services/sessionFork/workspace';
import {
  buildPortableIsolatedAnchorEvidenceV1,
} from '../../../../src/host/services/sessionFork/portability/portableWorkspaceEvidence';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-imported-portable-anchor-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  const durableRoot = path.join(root, 'durable');
  const intentState = path.join(root, 'intents');
  await mkdir(repositoryRoot, { recursive: true });
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\n');
  git(repositoryRoot, 'add', 'tracked.txt');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\nunstaged\n');
  await writeFile(path.join(repositoryRoot, 'new.bin'), Buffer.from([0, 1, 255, 2]));

  const evidenceService = new AnchorWorkspaceEvidenceService();
  const sourceEvidence = await evidenceService.capture({
    anchorId: 'assistant-a2',
    repositoryRoot,
    baseCommit,
    workspaceScopeVersion: 'source-scope-v1',
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: repositoryRoot,
      isolatedRelativePath: '.',
    }],
  });
  const repositoryIdentityDigest = `sha256:${createHash('sha256')
    .update(sourceEvidence.manifest.repositoryIdentity.fingerprint)
    .digest('hex')}`;
  const portableEvidence = buildPortableIsolatedAnchorEvidenceV1({
    evidenceId: 'portable-evidence-1',
    repositoryIdentityDigest,
    evidence: sourceEvidence,
  });
  const intentStore = new JsonWorkspaceForkIntentStore(intentState);
  const workspaceService = new IsolatedAnchorWorkspaceService({
    durableRoot,
    intentStore,
  });
  return {
    repositoryRoot,
    durableRoot,
    baseCommit,
    portableEvidence,
    intentStore,
    materializer: new ImportedPortableAnchorWorkspaceMaterializer({
      workspaceService,
      evidenceService,
    }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('ImportedPortableAnchorWorkspaceMaterializer', () => {
  it('rebinds source evidence to the trusted target repository and prepares a verified durable worktree', async () => {
    const fixture = await createFixture();

    const prepared = await fixture.materializer.materialize({
      portableEvidence: fixture.portableEvidence,
      targetProjectId: 'project-1',
      workspaceBinding: {
        projectId: 'project-1',
        topology: 'single_root_git',
        identityTrust: 'verified',
        repositoryRoot: fixture.repositoryRoot,
        workspaceScopeVersion: 'target-scope-v2',
      },
      intentId: 'import-intent-1',
      sourceSessionId: 'imported-parent',
      proposedChildSessionId: 'imported-child',
      destinationName: 'imported-child',
    });

    expect(prepared.advertisable).toBe(true);
    expect(git(prepared.workspacePath, 'rev-parse', 'HEAD')).toBe(fixture.baseCommit);
    expect(await readFile(path.join(prepared.workspacePath, 'tracked.txt'), 'utf8'))
      .toBe('staged\nunstaged\n');
    expect(await readFile(path.join(prepared.workspacePath, 'new.bin')))
      .toEqual(Buffer.from([0, 1, 255, 2]));
    expect(prepared.workspaceScopeVersion).toBe('target-scope-v2');
    expect(prepared.pathMappings).toEqual([
      expect.objectContaining({
        repositoryRelativePath: '.',
        isolatedRelativePath: '.',
        isolatedPath: prepared.workspacePath,
      }),
    ]);
    const persisted = await fixture.intentStore.get('import-intent-1');
    expect(persisted?.evidence.manifest.repositoryIdentity.canonicalRoot)
      .toBe(await realpath(fixture.repositoryRoot));
    expect(JSON.stringify(persisted?.evidence)).not.toContain(
      fixture.portableEvidence.repositoryIdentityDigest,
    );
  });

  it('rejects an unavailable base commit and never calls workspace preparation', async () => {
    const fixture = await createFixture();
    const prepare = vi.fn();
    const materializer = new ImportedPortableAnchorWorkspaceMaterializer({
      workspaceService: { prepare },
      evidenceService: new AnchorWorkspaceEvidenceService(),
    });
    const portableEvidence = structuredClone(fixture.portableEvidence);
    portableEvidence.baseCommit = 'f'.repeat(40);

    await expect(materializer.materialize({
      portableEvidence,
      targetProjectId: 'project-1',
      workspaceBinding: {
        projectId: 'project-1',
        topology: 'single_root_git',
        identityTrust: 'verified',
        repositoryRoot: fixture.repositoryRoot,
        workspaceScopeVersion: 'scope-v1',
      },
      intentId: 'missing-base',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      destinationName: 'child',
    })).rejects.toMatchObject({ code: 'BASE_COMMIT_UNAVAILABLE' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects untrusted bindings and tampered blobs before publishing a workspace', async () => {
    const fixture = await createFixture();
    const prepare = vi.fn();
    const materializer = new ImportedPortableAnchorWorkspaceMaterializer({
      workspaceService: { prepare },
      evidenceService: new AnchorWorkspaceEvidenceService(),
    });
    const tampered = structuredClone(fixture.portableEvidence);
    tampered.content.blobs[tampered.content.unstagedPatch.blobDigest] = 'bm90LXRoZS1wYXRjaA==';

    await expect(materializer.materialize({
      portableEvidence: fixture.portableEvidence,
      targetProjectId: 'project-1',
      workspaceBinding: {
        projectId: 'project-1',
        topology: 'single_root_git',
        identityTrust: 'unverified',
        repositoryRoot: fixture.repositoryRoot,
        workspaceScopeVersion: 'scope-v1',
      } as never,
      intentId: 'untrusted',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      destinationName: 'child',
    })).rejects.toMatchObject({ code: 'TARGET_WORKSPACE_BINDING_REQUIRED' });
    expect(prepare).not.toHaveBeenCalled();

    await expect(materializer.materialize({
      portableEvidence: tampered,
      targetProjectId: 'project-1',
      workspaceBinding: {
        projectId: 'project-1',
        topology: 'single_root_git',
        identityTrust: 'verified',
        repositoryRoot: fixture.repositoryRoot,
        workspaceScopeVersion: 'scope-v1',
      },
      intentId: 'tampered',
      sourceSessionId: 'parent',
      proposedChildSessionId: 'child',
      destinationName: 'child',
    })).rejects.toThrow(/DIGEST_MISMATCH/u);
    expect(prepare).not.toHaveBeenCalled();
  });
});
