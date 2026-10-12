import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  digestWorkspaceValue,
} from '../../../../src/host/services/sessionFork/workspace';
import { PortableEvidenceApplyBackEngine } from '../../../../src/host/services/sessionFork/workspace/portableEvidenceApplyBackEngine';
import type {
  AnchorWorkspaceEvidence,
  WorkspaceCommandRunner,
} from '../../../../src/host/services/sessionFork/workspace';

const CLOUD_TRACKED = 'staged\nunstaged\n';
const CLOUD_BINARY = Buffer.from([0, 1, 255, 2]);
const CLOUD_NOTE = 'cloud note\n';
const SHARED_CONTENT = 'shared content\n';
const PRIOR_SIDECAR = 'prior sidecar bytes\n';

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface ApplyBackFixture {
  repositoryRoot: string;
  baseCommit: string;
  portableEvidence: PortableIsolatedAnchorEvidenceV1;
  sourceEvidence: AnchorWorkspaceEvidence;
}

async function createFixture(options: { trackedEdits?: boolean } = {}): Promise<ApplyBackFixture> {
  const trackedEdits = options.trackedEdits !== false;
  const repositoryRoot = await initTempRepository();
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
  return await captureFixture({ repositoryRoot, baseCommit });
}

/**
 * Re-signs the captured evidence with one extra untracked entry, mirroring a
 * cloud producer whose manifest lists a path the capture harness would never
 * emit (e.g. inside .git). All digests stay self-consistent, so this exercises
 * the apply-back gate rather than the portability validation.
 */
async function buildTamperedPortableEvidence(
  sourceEvidence: AnchorWorkspaceEvidence,
  extraUntracked: { path: string; bytes: Buffer; mode: number },
): Promise<PortableIsolatedAnchorEvidenceV1> {
  const digest = createHash('sha256').update(extraUntracked.bytes).digest('hex');
  const payload = {
    ...sourceEvidence.payload,
    untrackedBlobs: {
      ...sourceEvidence.payload.untrackedBlobs,
      [digest]: extraUntracked.bytes.toString('base64'),
    },
  };
  const { evidenceDigest: _discarded, ...sourceManifestWithoutDigest } = sourceEvidence.manifest;
  const manifestWithoutDigest = {
    ...sourceManifestWithoutDigest,
    // The envelope validator rejects unsorted manifests, so the grafted entry
    // re-sorts into the captured list (localeCompare, like the validator).
    untrackedFiles: [
      {
        path: extraUntracked.path,
        sha256: digest,
        sizeBytes: extraUntracked.bytes.byteLength,
        mode: extraUntracked.mode,
      },
      ...sourceEvidence.manifest.untrackedFiles,
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const manifest = {
    ...manifestWithoutDigest,
    evidenceDigest: digestWorkspaceValue({ manifest: manifestWithoutDigest, payload }),
  };
  return await buildPortableIsolatedAnchorEvidenceV1({
    evidenceId: 'apply-back-tampered-1',
    repositoryIdentityDigest: `sha256:${createHash('sha256')
      .update(sourceEvidence.manifest.repositoryIdentity.fingerprint)
      .digest('hex')}`,
    evidence: { manifest, payload },
  });
}

/**
 * Re-signs the captured evidence with a fully replaced staged patch, so a
 * crafted section (e.g. a rename whose a-side header path escapes the
 * repository) reaches the apply-back gates with self-consistent digests.
 */
async function buildTamperedPatchEvidence(
  sourceEvidence: AnchorWorkspaceEvidence,
  stagedPatch: Buffer,
): Promise<PortableIsolatedAnchorEvidenceV1> {
  const payload = { ...sourceEvidence.payload, stagedPatchBase64: stagedPatch.toString('base64') };
  const { evidenceDigest: _discarded, ...sourceManifestWithoutDigest } = sourceEvidence.manifest;
  const manifestWithoutDigest = {
    ...sourceManifestWithoutDigest,
    stagedPatch: {
      sha256: createHash('sha256').update(stagedPatch).digest('hex'),
      sizeBytes: stagedPatch.byteLength,
    },
  };
  const manifest = {
    ...manifestWithoutDigest,
    evidenceDigest: digestWorkspaceValue({ manifest: manifestWithoutDigest, payload }),
  };
  return await buildPortableIsolatedAnchorEvidenceV1({
    evidenceId: 'apply-back-tampered-patch-1',
    repositoryIdentityDigest: `sha256:${createHash('sha256')
      .update(sourceEvidence.manifest.repositoryIdentity.fingerprint)
      .digest('hex')}`,
    evidence: { manifest, payload },
  });
}

async function captureFixture(options: {
  repositoryRoot: string;
  baseCommit: string;
}): Promise<ApplyBackFixture> {
  const { repositoryRoot, baseCommit } = options;
  const sourceEvidence = await new AnchorWorkspaceEvidenceService().capture({
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
  return { repositoryRoot, baseCommit, portableEvidence, sourceEvidence };
}

/**
 * A pure `git mv` staged in the cloud session: capture's `git diff --cached`
 * emits a single rename section (`rename from`/`rename to`) whose a-side
 * pre-image lives at a different path than the item's own b-side path.
 */
async function createRenameFixture(options: { cloudModifyExtra?: string } = {}): Promise<ApplyBackFixture> {
  const repositoryRoot = await initTempRepository();
  git(repositoryRoot, 'config', 'diff.renames', 'true');
  await writeFile(path.join(repositoryRoot, 'old.txt'), SHARED_CONTENT);
  if (options.cloudModifyExtra) {
    await writeFile(path.join(repositoryRoot, options.cloudModifyExtra), 'base\n');
  }
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
  git(repositoryRoot, 'mv', 'old.txt', 'new.txt');
  if (options.cloudModifyExtra) {
    await writeFile(path.join(repositoryRoot, options.cloudModifyExtra), 'cloud extra\n');
  }
  return await captureFixture({ repositoryRoot, baseCommit });
}

/** Minimal evidence: one base commit plus one untracked cloud file — small enough to tamper. */
async function createSingleFileFixture(): Promise<ApplyBackFixture> {
  const repositoryRoot = await initTempRepository();
  await writeFile(path.join(repositoryRoot, 'base.txt'), 'base\n');
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-m', 'base');
  const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
  await writeFile(path.join(repositoryRoot, 'cloud.txt'), 'cloud\n');
  return await captureFixture({ repositoryRoot, baseCommit });
}

async function initTempRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'neo-apply-back-'));
  temporaryDirectories.push(root);
  const repositoryRoot = path.join(root, 'repository');
  await mkdir(repositoryRoot, { recursive: true });
  git(repositoryRoot, 'init', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'neo-test@example.invalid');
  git(repositoryRoot, 'config', 'user.name', 'Neo Test');
  return repositoryRoot;
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

describe('applyPortableEvidenceToWorkspace · rework r1 regressions', () => {
  it('refuses untracked entries that target .git and never writes git metadata', async () => {
    const fixture = await createFixture();
    const hookBytes = Buffer.from('#!/bin/sh\necho injected\n');
    const portable = await buildTamperedPortableEvidence(fixture.sourceEvidence, {
      path: '.git/hooks/pre-commit',
      bytes: hookBytes,
      mode: 0o755,
    });
    const treeBefore = await hashWorktree(fixture.repositoryRoot);

    // Since rework r3 an envelope escape rejects the WHOLE apply instead of
    // degrading to a per-file conflict: hostile evidence applies nothing.
    for (const mode of ['dry-run', 'apply'] as const) {
      await expect(applyPortableEvidenceToWorkspace({
        evidence: portable,
        workspaceRoot: fixture.repositoryRoot,
        mode,
      })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    }
    await expect(applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { '.git/hooks/pre-commit': 'take-cloud' },
    })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    await expect(readFile(path.join(fixture.repositoryRoot, '.git', 'hooks', 'pre-commit')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await hashWorktree(fixture.repositoryRoot)).toBe(treeBefore);
  });

  it('rolls back earlier applied files when a later item fails after save-as', async () => {
    const repositoryRoot = await initTempRepository();
    for (const name of ['a.txt', 'm.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), 'base\n');
    }
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    for (const name of ['a.txt', 'm.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), `cloud ${name}\n`);
    }
    const fixture = await captureFixture({ repositoryRoot, baseCommit });
    await writeFile(path.join(repositoryRoot, 'm.txt'), 'local drift\n');
    const treeBefore = await hashWorktree(repositoryRoot);
    // Item order is a.txt, m.txt, z.txt: forward `git apply` calls are a.txt
    // (1), the save-as rebuild of m.txt (2), then z.txt fails on call 3 — with
    // an applied entry both before and after the save-as journal leftovers.
    const runner = createFailingApplyRunner((invocation) => (
      invocation >= 3 ? 'injected late failure' : null
    ));

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'm.txt': 'save-as' },
    }, { runner });
    expect(failed.outcome).toBe('failed');
    expect(failed.rollbackVerified).toBe(true);
    expect(failed.error).toContain('injected late failure');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
    expect(await readFile(path.join(repositoryRoot, 'a.txt'), 'utf8')).toBe('base\n');
    expect(await readFile(path.join(repositoryRoot, 'm.txt'), 'utf8')).toBe('local drift\n');
    await expect(readFile(path.join(repositoryRoot, 'm.txt.cloud')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps non-ASCII diff header paths intact instead of quotepath mojibake', async () => {
    const repositoryRoot = await initTempRepository();
    git(repositoryRoot, 'config', 'core.quotepath', 'true');
    await writeFile(path.join(repositoryRoot, '中文.md'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, '中文.md'), '云端\n');
    const fixture = await captureFixture({ repositoryRoot, baseCommit });
    await writeFile(path.join(repositoryRoot, '中文.md'), 'local drift\n');

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.conflicts).toEqual(['中文.md']);
    expect(dryRun.files.every((file) => !file.path.includes('ä'))).toBe(true);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { '中文.md': 'save-as' },
    });
    expect(applied.outcome).toBe('success');
    const saved = applied.files.find((file) => file.path === '中文.md');
    expect(saved?.status).toBe('saved-as-cloud');
    expect(saved?.savedAs).toBe('中文.md.cloud');
    expect(await readFile(path.join(repositoryRoot, '中文.md'), 'utf8')).toBe('local drift\n');
    expect(await readFile(path.join(repositoryRoot, '中文.md.cloud'), 'utf8')).toBe('云端\n');
  });
});

describe('applyPortableEvidenceToWorkspace · rework r2 regressions', () => {
  it('save-as never clobbers a pre-existing sidecar and shifts to .cloud.2', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'local drift\n');
    await writeFile(path.join(fixture.repositoryRoot, 'tracked.txt.cloud'), PRIOR_SIDECAR);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
      resolutions: { 'tracked.txt': 'save-as' },
    });
    expect(applied.outcome).toBe('success');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe('local drift\n');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt.cloud'), 'utf8')).toBe(PRIOR_SIDECAR);
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt.cloud.2'), 'utf8')).toBe(CLOUD_TRACKED);
    const saved = applied.files.find((file) => file.path === 'tracked.txt');
    expect(saved?.status).toBe('saved-as-cloud');
    expect(saved?.savedAs).toBe('tracked.txt.cloud.2');
  });

  it('rollback restores a pre-existing sidecar instead of deleting it', async () => {
    const repositoryRoot = await initTempRepository();
    for (const name of ['a.txt', 'm.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), 'base\n');
    }
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    for (const name of ['a.txt', 'm.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), `cloud ${name}\n`);
    }
    const fixture = await captureFixture({ repositoryRoot, baseCommit });
    await writeFile(path.join(repositoryRoot, 'm.txt'), 'local drift\n');
    await writeFile(path.join(repositoryRoot, 'm.txt.cloud'), PRIOR_SIDECAR);
    const treeBefore = await hashWorktree(repositoryRoot);
    // Item order is a.txt, m.txt, z.txt: forward `git apply` calls are a.txt
    // (1), the save-as rebuild of m.txt (2), then z.txt fails on call 3.
    const runner = createFailingApplyRunner((invocation) => (
      invocation >= 3 ? 'injected late failure' : null
    ));

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'm.txt': 'save-as' },
    }, { runner });
    expect(failed.outcome).toBe('failed');
    expect(failed.rollbackVerified).toBe(true);
    expect(failed.error).toContain('injected late failure');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
    expect(await readFile(path.join(repositoryRoot, 'm.txt'), 'utf8')).toBe('local drift\n');
    expect(await readFile(path.join(repositoryRoot, 'm.txt.cloud'), 'utf8')).toBe(PRIOR_SIDECAR);
  });

  it('honours take-cloud for a rename item whose a-side file was deleted locally', async () => {
    const fixture = await createRenameFixture();
    const { repositoryRoot } = fixture;
    await rm(path.join(repositoryRoot, 'old.txt'));
    await writeFile(path.join(repositoryRoot, 'new.txt'), 'local new\n');

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.outcome).toBe('partial');
    expect(dryRun.conflicts).toEqual(['new.txt']);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'new.txt': 'take-cloud' },
    });
    expect(applied.outcome).toBe('success');
    expect(applied.files.find((file) => file.path === 'new.txt')?.status).toBe('took-cloud');
    expect(await readFile(path.join(repositoryRoot, 'new.txt'), 'utf8')).toBe(SHARED_CONTENT);
    await expect(readFile(path.join(repositoryRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back a rename take-cloud together with the restored a-side preimage', async () => {
    const fixture = await createRenameFixture({ cloudModifyExtra: 'z.txt' });
    const { repositoryRoot } = fixture;
    await rm(path.join(repositoryRoot, 'old.txt'));
    await writeFile(path.join(repositoryRoot, 'new.txt'), 'local new\n');
    const treeBefore = await hashWorktree(repositoryRoot);
    // Forward `git apply` calls: the rename rebuild of new.txt (1), then z.txt
    // fails on call 2 — after the rename itself was applied and journaled.
    const runner = createFailingApplyRunner((invocation) => (
      invocation >= 2 ? 'injected late failure' : null
    ));

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'new.txt': 'take-cloud' },
    }, { runner });
    expect(failed.outcome).toBe('failed');
    expect(failed.rollbackVerified).toBe(true);
    expect(failed.error).toContain('injected late failure');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
    expect(await readFile(path.join(repositoryRoot, 'new.txt'), 'utf8')).toBe('local new\n');
    await expect(readFile(path.join(repositoryRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honours save-as for a rename item whose a-side file was deleted locally', async () => {
    const fixture = await createRenameFixture();
    const { repositoryRoot } = fixture;
    await rm(path.join(repositoryRoot, 'old.txt'));
    await writeFile(path.join(repositoryRoot, 'new.txt'), 'local new\n');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'new.txt': 'save-as' },
    });
    expect(applied.outcome).toBe('success');
    const saved = applied.files.find((file) => file.path === 'new.txt');
    expect(saved?.status).toBe('saved-as-cloud');
    expect(saved?.savedAs).toBe('new.txt.cloud');
    expect(await readFile(path.join(repositoryRoot, 'new.txt'), 'utf8')).toBe('local new\n');
    expect(await readFile(path.join(repositoryRoot, 'new.txt.cloud'), 'utf8')).toBe(SHARED_CONTENT);
    await expect(readFile(path.join(repositoryRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('applyPortableEvidenceToWorkspace · rework r3 regressions', () => {
  it('dry-run lists a rename a-side path as a path that would change', async () => {
    const fixture = await createRenameFixture();

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.outcome).toBe('success');
    expect(dryRun.wouldChange).toEqual(['new.txt', 'old.txt']);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(applied.wouldChange).toEqual(['new.txt', 'old.txt']);
    expect(await readFile(path.join(fixture.repositoryRoot, 'new.txt'), 'utf8')).toBe(SHARED_CONTENT);
    await expect(readFile(path.join(fixture.repositoryRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a rename whose a-side pre-image escapes the repository, applying nothing', async () => {
    const fixture = await createSingleFileFixture();
    const { repositoryRoot } = fixture;
    const sentinel = path.join(path.dirname(repositoryRoot), 'outside-sentinel.txt');
    await writeFile(sentinel, 'do not touch\n');
    const treeBefore = await hashWorktree(repositoryRoot);
    const portable = await buildTamperedPatchEvidence(fixture.sourceEvidence, Buffer.from(
      'diff --git a/../outside-sentinel.txt b/safe.txt\n'
      + 'similarity index 100%\n'
      + 'rename from ../outside-sentinel.txt\n'
      + 'rename to safe.txt\n',
    ));

    await expect(applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: repositoryRoot,
      mode: 'dry-run',
    })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    await expect(applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: repositoryRoot,
      mode: 'dry-run',
    })).rejects.toThrow(/outside-sentinel\.txt/);
    await expect(applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
    })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    await expect(applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'safe.txt': 'take-cloud' },
    })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    expect(await readFile(sentinel, 'utf8')).toBe('do not touch\n');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
  });

  it('rejects a-side pre-images that are absolute or inside .git', async () => {
    const fixture = await createSingleFileFixture();
    const { repositoryRoot } = fixture;
    await mkdir(path.join(repositoryRoot, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(repositoryRoot, '.git', 'evil'), 'git sentinel\n');
    const treeBefore = await hashWorktree(repositoryRoot);
    const cases = [
      'diff --git a//etc/passwd b/safe.txt\nsimilarity index 100%\nrename from /etc/passwd\nrename to safe.txt\n',
      'diff --git a/.git/evil b/safe.txt\nsimilarity index 100%\nrename from .git/evil\nrename to safe.txt\n',
    ];
    for (const patch of cases) {
      const portable = await buildTamperedPatchEvidence(fixture.sourceEvidence, Buffer.from(patch));
      await expect(applyPortableEvidenceToWorkspace({
        evidence: portable,
        workspaceRoot: repositoryRoot,
        mode: 'dry-run',
      })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
      await expect(applyPortableEvidenceToWorkspace({
        evidence: portable,
        workspaceRoot: repositoryRoot,
        mode: 'apply',
        resolutions: { 'safe.txt': 'take-cloud' },
      })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    }
    expect(await readFile(path.join(repositoryRoot, '.git', 'evil'), 'utf8')).toBe('git sentinel\n');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
  });

  it('take-cloud refuses to follow a symlinked parent out of the repository', async () => {
    const fixture = await createSingleFileFixture();
    const { repositoryRoot } = fixture;
    const outsideDir = path.join(path.dirname(repositoryRoot), 'outside-dir');
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, 'secret.txt'), 'outside secret\n');
    await symlink(outsideDir, path.join(repositoryRoot, 'link'));
    await writeFile(path.join(repositoryRoot, 'new.txt'), 'local drift\n');
    const treeBefore = await hashWorktree(repositoryRoot);
    const portable = await buildTamperedPatchEvidence(fixture.sourceEvidence, Buffer.from(
      'diff --git a/link/secret.txt b/new.txt\n'
      + 'similarity index 100%\n'
      + 'rename from link/secret.txt\n'
      + 'rename to new.txt\n',
    ));

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'new.txt': 'take-cloud' },
    });
    expect(failed.outcome).toBe('failed');
    expect(failed.error).toContain('symlink');
    expect(failed.rollbackVerified).toBe(true);
    expect(await readFile(path.join(outsideDir, 'secret.txt'), 'utf8')).toBe('outside secret\n');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
  });

  it('engine rejects an unsafe rename pre-image before any filesystem effect', async () => {
    const fixture = await createSingleFileFixture();
    const { repositoryRoot, baseCommit } = fixture;
    const sentinel = path.join(path.dirname(repositoryRoot), 'id_rsa');
    await writeFile(sentinel, 'secret key\n');
    await writeFile(path.join(repositoryRoot, 'safe.txt'), 'local\n');
    const treeBefore = await hashWorktree(repositoryRoot);
    const engine = new PortableEvidenceApplyBackEngine(
      new NodeWorkspaceCommandRunner(),
      repositoryRoot,
      baseCommit,
    );
    const item = {
      kind: 'patch' as const,
      path: 'safe.txt',
      source: 'unstaged-patch' as const,
      sections: [Buffer.from(
        'diff --git a/../id_rsa b/safe.txt\n'
        + 'similarity index 100%\n'
        + 'rename from ../id_rsa\n'
        + 'rename to safe.txt\n',
      )],
      preimagePaths: [],
    };

    await expect(engine.resolveConflict(item, { status: 'conflict', reason: 'drift' }, 'take-cloud'))
      .rejects.toThrow('safety envelope');
    expect(await readFile(sentinel, 'utf8')).toBe('secret key\n');
    await engine.rollback();
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
  });
});

describe('applyPortableEvidenceToWorkspace · rework r4 regressions', () => {
  it('rejects .git targets that differ only by case and never writes git metadata', async () => {
    const fixture = await createFixture();
    const hookBytes = Buffer.from('#!/bin/sh\necho injected\n');
    // On a case-insensitive volume either variant resolves into the real
    // `.git`, so the lexical gate must fold case before the name check.
    for (const variant of ['.GIT/hooks/pre-commit', '.Git/hooks/pre-commit']) {
      const portable = await buildTamperedPortableEvidence(fixture.sourceEvidence, {
        path: variant,
        bytes: hookBytes,
        mode: 0o755,
      });
      for (const mode of ['dry-run', 'apply'] as const) {
        await expect(applyPortableEvidenceToWorkspace({
          evidence: portable,
          workspaceRoot: fixture.repositoryRoot,
          mode,
        })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
      }
    }
    await expect(readFile(path.join(fixture.repositoryRoot, '.git', 'hooks', 'pre-commit')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves paths containing " b/" from ---/+++ lines instead of the header split', async () => {
    const repositoryRoot = await initTempRepository();
    await mkdir(path.join(repositoryRoot, 'docs b'));
    await writeFile(path.join(repositoryRoot, 'docs b', 'notes.md'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, 'docs b', 'notes.md'), 'cloud notes\n');
    git(repositoryRoot, 'add', 'docs b/notes.md');
    const fixture = await captureFixture({ repositoryRoot, baseCommit });
    await writeFile(path.join(repositoryRoot, 'docs b', 'notes.md'), 'local drift\n');
    // The mis-split pre-image of the old parser was exactly `docs`: a local
    // file there must survive even the take-cloud path untouched.
    await writeFile(path.join(repositoryRoot, 'docs'), 'innocent local docs\n');

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.conflicts).toEqual(['docs b/notes.md']);
    expect(dryRun.files.map((file) => file.path)).toEqual(['docs b/notes.md']);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'docs b/notes.md': 'take-cloud' },
    });
    expect(applied.outcome).toBe('success');
    expect(applied.files.find((file) => file.path === 'docs b/notes.md')?.status).toBe('took-cloud');
    expect(await readFile(path.join(repositoryRoot, 'docs b', 'notes.md'), 'utf8')).toBe('cloud notes\n');
    expect(await readFile(path.join(repositoryRoot, 'docs'), 'utf8')).toBe('innocent local docs\n');
  });

  it('rejects evidence whose untracked entry duplicates a modified tracked path', async () => {
    const fixture = await createFixture();
    const portable = await buildTamperedPortableEvidence(fixture.sourceEvidence, {
      path: 'tracked.txt',
      bytes: Buffer.from('evil overlap\n'),
      mode: 0o644,
    });
    const treeBefore = await hashWorktree(fixture.repositoryRoot);

    for (const mode of ['dry-run', 'apply'] as const) {
      await expect(applyPortableEvidenceToWorkspace({
        evidence: portable,
        workspaceRoot: fixture.repositoryRoot,
        mode,
      })).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE_PATH' });
    }
    expect(await hashWorktree(fixture.repositoryRoot)).toBe(treeBefore);
  });

  it('applies a git rm --cached file as one untracked item instead of delete-then-recreate', async () => {
    const repositoryRoot = await initTempRepository();
    await writeFile(path.join(repositoryRoot, 'f.txt'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    // The only overlap real capture produces: the index deletion keeps the
    // disk copy, so the manifest lists the path as untracked with its bytes.
    git(repositoryRoot, 'rm', '--cached', 'f.txt');
    await writeFile(path.join(repositoryRoot, 'f.txt'), 'cloud kept\n');
    const fixture = await captureFixture({ repositoryRoot, baseCommit });

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'dry-run',
    });
    expect(dryRun.conflicts).toEqual(['f.txt']);
    expect(dryRun.files.filter((file) => file.path === 'f.txt')).toHaveLength(1);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'f.txt': 'take-cloud' },
    });
    expect(applied.outcome).toBe('success');
    expect(applied.files.filter((file) => file.path === 'f.txt')).toHaveLength(1);
    expect(applied.files.find((file) => file.path === 'f.txt')?.status).toBe('took-cloud');
    expect(await readFile(path.join(repositoryRoot, 'f.txt'), 'utf8')).toBe('cloud kept\n');
  });

  it('rolls back file modes together with bytes when a later apply fails', async () => {
    const repositoryRoot = await initTempRepository();
    for (const name of ['a.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), 'base\n');
    }
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, 'a.txt'), 'cloud\n');
    await chmod(path.join(repositoryRoot, 'a.txt'), 0o755);
    await writeFile(path.join(repositoryRoot, 'z.txt'), 'cloud z\n');
    git(repositoryRoot, 'add', 'a.txt', 'z.txt');
    const fixture = await captureFixture({ repositoryRoot, baseCommit });
    await writeFile(path.join(repositoryRoot, 'a.txt'), 'local drift\n');
    await chmod(path.join(repositoryRoot, 'a.txt'), 0o755);
    const treeBefore = await hashWorktree(repositoryRoot);
    // Forward `git apply` calls: the take-cloud rebuild of a.txt (1), then
    // z.txt fails on call 2 — after the mode-changing rebuild was journalled.
    const runner = createFailingApplyRunner((invocation) => (
      invocation >= 2 ? 'injected late failure' : null
    ));

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'a.txt': 'take-cloud' },
    }, { runner });
    expect(failed.outcome).toBe('failed');
    expect(failed.rollbackVerified).toBe(true);
    expect(failed.error).toContain('injected late failure');
    expect(await hashWorktree(repositoryRoot)).toBe(treeBefore);
    expect((await lstat(path.join(repositoryRoot, 'a.txt'))).mode & 0o777).toBe(0o755);
  });

  it('reports rolled-back per-file context instead of an empty file list on failure', async () => {
    const repositoryRoot = await initTempRepository();
    for (const name of ['a.txt', 'm.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), 'base\n');
    }
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    for (const name of ['a.txt', 'm.txt', 'z.txt']) {
      await writeFile(path.join(repositoryRoot, name), `cloud ${name}\n`);
    }
    const fixture = await captureFixture({ repositoryRoot, baseCommit });
    await writeFile(path.join(repositoryRoot, 'm.txt'), 'local drift\n');
    // Forward `git apply` calls: a.txt (1), the save-as rebuild of m.txt (2),
    // then z.txt fails on call 3 — one applied and one saved-as entry exist.
    const runner = createFailingApplyRunner((invocation) => (
      invocation >= 3 ? 'injected late failure' : null
    ));

    const failed = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: repositoryRoot,
      mode: 'apply',
      resolutions: { 'm.txt': 'save-as' },
    }, { runner });
    expect(failed.outcome).toBe('failed');
    const statuses = new Map(failed.files.map((file) => [file.path, file.status]));
    expect(statuses.get('a.txt')).toBe('rolled-back');
    expect(statuses.get('m.txt')).toBe('rolled-back');
    expect(failed.files.every((file) => (
      file.status !== 'applied' && file.status !== 'took-cloud' && file.status !== 'saved-as-cloud'
    ))).toBe(true);
  });
});

describe('applyPortableEvidenceToWorkspace · rework r5 regressions', () => {
  it('captures a/ b/ prefixed patches under diff.noprefix and applies them back', async () => {
    const repositoryRoot = await initTempRepository();
    git(repositoryRoot, 'config', 'diff.noprefix', 'true');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\n');
    git(repositoryRoot, 'add', 'tracked.txt');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), CLOUD_TRACKED);
    const fixture = await captureFixture({ repositoryRoot, baseCommit });

    // Without pinned prefixes, diff.noprefix makes both patches header-less
    // (`--- tracked.txt`), which plain `git apply` later refuses to parse.
    const stagedPatch = Buffer.from(fixture.sourceEvidence.payload.stagedPatchBase64, 'base64').toString('utf8');
    const unstagedPatch = Buffer.from(fixture.sourceEvidence.payload.unstagedPatchBase64, 'base64').toString('utf8');
    expect(stagedPatch).toContain('--- a/tracked.txt');
    expect(stagedPatch).toContain('+++ b/tracked.txt');
    expect(unstagedPatch).toContain('--- a/tracked.txt');
    expect(unstagedPatch).toContain('+++ b/tracked.txt');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe(CLOUD_TRACKED);
  });
});

describe('applyPortableEvidenceToWorkspace · rework r6 regressions', () => {
  it('captures real patches despite a junk diff.external tool and applies them back', async () => {
    const repositoryRoot = await initTempRepository();
    // A user-configured external diff (e.g. difftastic) replaces the patch with
    // its own output; without --no-ext-diff the evidence payload is that junk.
    const externalScript = path.join(path.dirname(repositoryRoot), 'junk-ext-diff.sh');
    await writeFile(externalScript, '#!/bin/sh\necho "EXTERNAL junk output"\n');
    await chmod(externalScript, 0o755);
    git(repositoryRoot, 'config', 'diff.external', externalScript);
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\n');
    git(repositoryRoot, 'add', 'tracked.txt');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), CLOUD_TRACKED);
    // Sanity: plain `git diff` really is hijacked by the external tool here.
    expect(git(repositoryRoot, 'diff', '--binary', '--full-index', '--')).toContain('EXTERNAL junk output');
    const fixture = await captureFixture({ repositoryRoot, baseCommit });

    const stagedPatch = Buffer.from(fixture.sourceEvidence.payload.stagedPatchBase64, 'base64').toString('utf8');
    expect(stagedPatch).toContain('--- a/tracked.txt');
    expect(stagedPatch.includes('EXTERNAL')).toBe(false);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(applied.conflicts).toEqual([]);
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe(CLOUD_TRACKED);
  });

  it('captures a/ b/ prefixed patches under diff.mnemonicPrefix and applies them back', async () => {
    const repositoryRoot = await initTempRepository();
    git(repositoryRoot, 'config', 'diff.mnemonicPrefix', 'true');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\n');
    git(repositoryRoot, 'add', 'tracked.txt');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), CLOUD_TRACKED);
    const fixture = await captureFixture({ repositoryRoot, baseCommit });

    // Without pinned prefixes, mnemonicPrefix makes both patches carry `i/`/`w/`
    // (worktree) and `c/`/`i/` (cached) instead of the standard `a/`/`b/`.
    const stagedPatch = Buffer.from(fixture.sourceEvidence.payload.stagedPatchBase64, 'base64').toString('utf8');
    const unstagedPatch = Buffer.from(fixture.sourceEvidence.payload.unstagedPatchBase64, 'base64').toString('utf8');
    expect(stagedPatch).toContain('--- a/tracked.txt');
    expect(stagedPatch).toContain('+++ b/tracked.txt');
    expect(unstagedPatch).toContain('--- a/tracked.txt');
    expect(unstagedPatch).toContain('+++ b/tracked.txt');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe(CLOUD_TRACKED);
  });

  it('captures a/ b/ prefixed patches under diff.srcPrefix=x/ and applies them back', async () => {
    const repositoryRoot = await initTempRepository();
    git(repositoryRoot, 'config', 'diff.srcPrefix', 'x/');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
    git(repositoryRoot, 'add', '.');
    git(repositoryRoot, 'commit', '-m', 'base');
    const baseCommit = git(repositoryRoot, 'rev-parse', 'HEAD');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), 'staged\n');
    git(repositoryRoot, 'add', 'tracked.txt');
    await writeFile(path.join(repositoryRoot, 'tracked.txt'), CLOUD_TRACKED);
    const fixture = await captureFixture({ repositoryRoot, baseCommit });

    // Without pinned prefixes, a custom srcPrefix makes every --- header carry
    // `x/` instead of `a/` (dstPrefix stays `b/`).
    const stagedPatch = Buffer.from(fixture.sourceEvidence.payload.stagedPatchBase64, 'base64').toString('utf8');
    const unstagedPatch = Buffer.from(fixture.sourceEvidence.payload.unstagedPatchBase64, 'base64').toString('utf8');
    expect(stagedPatch).toContain('--- a/tracked.txt');
    expect(unstagedPatch).toContain('--- a/tracked.txt');

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: fixture.portableEvidence,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('success');
    expect(await readFile(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8')).toBe(CLOUD_TRACKED);
  });

  it('reports legacy prefix-less sections with the exact re-capture reason', async () => {
    const fixture = await createSingleFileFixture();
    // Two legacy shapes: mnemonic `i/`/`w/` prefixes and bare paths — both
    // captured before prefix pinning; neither parses to a repository path.
    const legacyPatch = Buffer.from(
      'diff --git i/tracked.txt w/tracked.txt\n'
      + 'index 0123456..1234567 100644\n'
      + '--- i/tracked.txt\n'
      + '+++ w/tracked.txt\n'
      + '@@ -1 +1 @@\n'
      + '-base\n'
      + '+cloud\n'
      + 'diff --git tracked2.txt tracked2.txt\n'
      + 'index 0123456..1234567 100644\n'
      + '--- tracked2.txt\n'
      + '+++ tracked2.txt\n'
      + '@@ -1 +1 @@\n'
      + '-base\n'
      + '+cloud\n',
    );
    const portable = await buildTamperedPatchEvidence(fixture.sourceEvidence, legacyPatch);

    const dryRun = await applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'dry-run',
    });
    const legacy = dryRun.files.filter((file) => file.status === 'conflict');
    expect(legacy).toHaveLength(2);
    expect(legacy.every((file) => file.reason === 'evidence captured with non-standard diff prefix; re-capture needed'))
      .toBe(true);

    const applied = await applyPortableEvidenceToWorkspace({
      evidence: portable,
      workspaceRoot: fixture.repositoryRoot,
      mode: 'apply',
    });
    expect(applied.outcome).toBe('partial');
    expect(applied.files
      .filter((file) => file.status === 'conflict')
      .every((file) => file.reason === 'evidence captured with non-standard diff prefix; re-capture needed'))
      .toBe(true);
  });
});
