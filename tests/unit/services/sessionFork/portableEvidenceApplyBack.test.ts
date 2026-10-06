import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PortableIsolatedAnchorEvidenceV1 } from '../../../../src/shared/contract/sessionForkPortability';
import {
  buildPortableIsolatedAnchorEvidenceV1,
} from '../../../../src/host/services/sessionFork/portability/portableWorkspaceEvidence';
import {
  AnchorWorkspaceEvidenceService,
  NodeWorkspaceCommandRunner,
  applyPortableEvidenceToWorkspace,
} from '../../../../src/host/services/sessionFork/workspace';
import type { WorkspaceCommandRunner } from '../../../../src/host/services/sessionFork/workspace';

const CLOUD_TRACKED = 'staged\nunstaged\n';
const CLOUD_BINARY = Buffer.from([0, 1, 255, 2]);
const CLOUD_NOTE = 'cloud note\n';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface ApplyBackFixture {
  repositoryRoot: string;
  baseCommit: string;
  portableEvidence: PortableIsolatedAnchorEvidenceV1;
}

async function createFixture(options: { trackedEdits?: boolean } = {}): Promise<ApplyBackFixture> {
  const trackedEdits = options.trackedEdits !== false;
  const root = await mkdtemp(path.join(tmpdir(), 'neo-apply-back-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  await mkdir(repositoryRoot, { recursive: true });
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
  if (trackedEdits) {
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\n');
    git(repositoryRoot, 'add', 'tracked.txt');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), CLOUD_TRACKED);
  }
  await writeFile(path.join(repositoryRoot, 'new.bin'), CLOUD_BINARY);
  await mkdir(path.join(repositoryRoot, 'notes'));
  await writeFile(path.join(repositoryRoot, 'notes', 'deep.md'), CLOUD_NOTE);
  const evidenceService = new AnchorWorkspaceEvidenceService();
  const sourceEvidence = await evidenceService.capture({
    anchorId: 'apply-back-source',
    repositoryRoot,
    baseCommit,
    workspaceScopeVersion: 'apply-back-scope-v1',
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: repositoryRoot,
      isolatedRelativePath: '.',
    }],
  });
  const portableEvidence = buildPortableIsolatedAnchorEvidenceV1({
    evidenceId: 'apply-back-evidence-1',
    repositoryIdentityDigest: `sha256:${createHash('sha256')
      .update(sourceEvidence.manifest.repositoryIdentity.fingerprint)
      .digest('hex')}`,
    evidence: sourceEvidence,
  });
  git(repositoryRoot, 'reset', '--hard', baseCommit);
  git(repositoryRoot, 'clean', '-fdx');
  return { repositoryRoot, baseCommit, portableEvidence };
}

async function hashWorktree(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        lines.push(`${relative} ${(info.mode & 0o777).toString(8)} ${createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex')}`);
      }
    }
  };
  await walk(root, '');
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function createFailingApplyRunner(failure: (invocation: number) => string | null): WorkspaceCommandRunner {
  let invocations = 0;
  return {
    async run(command) {
      if (
        command.executable === 'git'
        && command.args[0] === 'apply'
        && !command.args.includes('--check')
        && !command.args.includes('--reverse')
      ) {
        invocations += 1;
        const message = failure(invocations);
        if (message !== null) throw new Error(message);
      }
      return await new NodeWorkspaceCommandRunner().run(command);
    },
  };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('applyPortableEvidenceToWorkspace', () => {
  it('applies everything on a clean tree and never touches the index', async () => {
    const fixture = await createFixture();

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.outcome).toBe('success');
    expect([...dryRun.wouldChange].sort()).toEqual(['new.bin', 'notes/deep.md', 'tracked.txt']);
    expect(dryRun.conflicts).toEqual([]);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(applied.conflicts).toEqual([]);
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe(CLOUD_TRACKED);
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.bin'))).toEqual(CLOUD_BINARY);
    expect(await readFile(path.join(fixture.repositoryRoot, 'notes', 'deep.md'), 'utf8')).toBe(CLOUD_NOTE);
    expect(execFileSync('git', ['status', '--porcelain', '--', 'tracked.txt'], {
      cwd: fixture.repositoryRoot,
      encoding: 'utf8',
    })).toBe(' M tracked.txt\n');
  });

  it('dry-run writes nothing to disk or the index', async () => {
    const fixture = await createFixture();
    const treeBefore = await hashWorktree(fixture.repositoryRoot);
    const statusBefore = git(fixture.repositoryRoot, 'status', '--porcelain');

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.outcome).toBe('success');
    expect(await hashWorktree(fixture.repositoryRoot)).toBe(treeBefore);
    expect(git(fixture.repositoryRoot, 'status', '--porcelain')).toBe(statusBefore);
  });

  it('reports conflicts with actionable options and applies only the clean files (partial)', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'local drift\n');
    await writeFile(path.join(fixture.repositoryRoot, 'new.bin'), 'local copy');

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.outcome).toBe('partial');
    expect([...dryRun.conflicts].sort()).toEqual(['new.bin', 'tracked.txt']);
    expect(dryRun.wouldChange).toEqual(['notes/deep.md']);
    for (const report of dryRun.files.filter((file) => file.status === 'conflict')) {
      expect(report.options).toEqual(['keep-local', 'take-cloud', 'save-as']);
      expect(report.reason).toBeTruthy();
    }

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('partial');
    expect([...applied.conflicts].sort()).toEqual(['new.bin', 'tracked.txt']);
    expect(applied.wouldChange).toEqual(['notes/deep.md']);
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe('local drift\n');
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.bin'), 'utf8')).toBe('local copy');
    expect(await readFile(path.join(fixture.repositoryRoot, 'notes', 'deep.md'), 'utf8')).toBe(CLOUD_NOTE);
  });

  it('honours take-cloud by overwriting local drift with the cloud bytes', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'local drift\n');
    await writeFile(path.join(fixture.repositoryRoot, 'new.bin'), 'local copy');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { 'tracked.txt': 'take-cloud', 'new.bin': 'take-cloud' },
    });
    expect(applied.outcome).toBe('success');
    expect(applied.files
      .filter((file) => file.status === 'took-cloud')
      .map((file) => file.path)
      .sort()).toEqual(['new.bin', 'tracked.txt']);
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe(CLOUD_TRACKED);
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.bin'))).toEqual(CLOUD_BINARY);
  });

  it('honours keep-local by leaving the conflicting local file untouched', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'local drift\n');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { 'tracked.txt': 'keep-local' },
    });
    expect(applied.outcome).toBe('success');
    expect(applied.files.find((file) => file.path === 'tracked.txt')?.status).toBe('kept-local');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe('local drift\n');
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.bin'))).toEqual(CLOUD_BINARY);
  });

  it('honours save-as by writing the cloud copy beside the local file', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'local drift\n');
    await writeFile(path.join(fixture.repositoryRoot, 'new.bin'), 'local copy');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { 'tracked.txt': 'save-as', 'new.bin': 'save-as' },
    });
    expect(applied.outcome).toBe('success');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe('local drift\n');
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.bin'), 'utf8')).toBe('local copy');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt.cloud'), 'utf8')).toBe(CLOUD_TRACKED);
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.bin.cloud'))).toEqual(CLOUD_BINARY);
    const savedReport = applied.files.find((file) => file.path === 'tracked.txt');
    expect(savedReport?.status).toBe('saved-as-cloud');
    expect(savedReport?.savedAs).toBe('tracked.txt.cloud');
  });

  it('rolls back to a byte-identical tree when an apply command fails mid-way (failed)', async () => {
    const fixture = await createFixture();
    const runner = createFailingApplyRunner((invocation) => (
      invocation > 1 ? `injected apply failure #${invocation}` : null
    ));
    const treeBefore = await hashWorktree(fixture.repositoryRoot);

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    }, { runner });
    expect(failed.outcome).toBe('failed');
    expect(failed.rollbackVerified).toBe(true);
    expect(failed.error).toContain('injected apply failure');
    expect(await hashWorktree(fixture.repositoryRoot)).toBe(treeBefore);
  });

  it('rolls back take-cloud overwrites when the cloud reconstruction fails', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'local drift\n');
    const runner = createFailingApplyRunner(() => 'injected reconstruction failure');
    const treeBefore = await hashWorktree(fixture.repositoryRoot);

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { 'tracked.txt': 'take-cloud' },
    }, { runner });
    expect(failed.outcome).toBe('failed');
    expect(failed.rollbackVerified).toBe(true);
    expect(failed.error).toContain('injected reconstruction failure');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe('local drift\n');
    expect(await hashWorktree(fixture.repositoryRoot)).toBe(treeBefore);
  });

  it('rejects an untrusted binding before touching the workspace', async () => {
    const fixture = await createFixture();
    const unboundRoot = await mkdtemp(path.join(tmpdir(), 'neo-apply-back-unbound-'));
    temporaryDirectories.push(unboundRoot);

    await expect(applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: unboundRoot,
      mode: 'dry-run',
    })).rejects.toMatchObject({ code: 'EVIDENCE_BINDING_REJECTED' });
    await expect(applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
      resolutions: { 'tracked.txt': 'keep-local' },
    })).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
    await expect(applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { 'no-such-file.txt': 'keep-local' },
    })).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
  });

  it('treats identical untracked content as already-present instead of a change', async () => {
    const fixture = await createFixture({ trackedEdits: false });
    await writeFile(path.join(fixture.repositoryRoot, 'new.bin'), CLOUD_BINARY);
    await mkdir(path.join(fixture.repositoryRoot, 'notes'));
    await writeFile(path.join(fixture.repositoryRoot, 'notes', 'deep.md'), CLOUD_NOTE);

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.outcome).toBe('success');
    expect(dryRun.wouldChange).toEqual([]);
    expect(dryRun.files
      .filter((file) => file.status === 'already-present')
      .map((file) => file.path)
      .sort()).toEqual(['new.bin', 'notes/deep.md']);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(applied.wouldChange).toEqual([]);
  });
});
