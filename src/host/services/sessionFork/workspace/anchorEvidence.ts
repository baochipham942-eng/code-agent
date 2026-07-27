import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { NodeWorkspaceCommandRunner } from './commandRunner';
import type {
  AnchorPatchDescriptor,
  AnchorPathMapping,
  AnchorRepositoryIdentity,
  AnchorUntrackedFile,
  AnchorWorkspaceEvidence,
  AnchorWorkspaceEvidenceManifest,
  CaptureAnchorWorkspaceEvidenceInput,
  WorkspaceCommandRunner,
} from './types';

export type AnchorEvidenceErrorCode =
  | 'ANCHOR_ID_REQUIRED'
  | 'BASE_COMMIT_REQUIRED'
  | 'BASE_COMMIT_INVALID'
  | 'WORKSPACE_SCOPE_REQUIRED'
  | 'PATH_MAPPING_INCOMPLETE'
  | 'PATH_MAPPING_INVALID'
  | 'REPOSITORY_IDENTITY_DRIFT'
  | 'EVIDENCE_INCOMPLETE'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'EVIDENCE_BUDGET_EXCEEDED'
  | 'ANCHOR_STATE_CHANGED'
  | 'TRACKED_STATE_HIDDEN'
  | 'IGNORED_WORKSPACE_STATE'
  | 'UNSUPPORTED_UNTRACKED_ENTRY';

export class AnchorEvidenceError extends Error {
  constructor(public readonly code: AnchorEvidenceErrorCode, message: string) {
    super(message);
    this.name = 'AnchorEvidenceError';
  }
}

interface AnchorEvidenceServiceOptions {
  runner?: WorkspaceCommandRunner;
  now?: () => number;
  maxPatchBytes?: number;
  maxUntrackedBytes?: number;
  maxUntrackedFiles?: number;
}

const DEFAULT_MAX_PATCH_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNTRACKED_FILES = 10_000;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

export function digestWorkspaceValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

function descriptor(buffer: Buffer): AnchorPatchDescriptor {
  return { sha256: sha256(buffer), sizeBytes: buffer.byteLength };
}

function normalizeGitPath(value: string, allowDot: boolean): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new AnchorEvidenceError('PATH_MAPPING_INVALID', `unsafe relative path: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if ((!allowDot && normalized === '.') || normalized === '..' || normalized.startsWith('../')) {
    throw new AnchorEvidenceError('PATH_MAPPING_INVALID', `path escapes the workspace: ${value}`);
  }
  return normalized;
}

function decodeBase64(value: string, label: string): Buffer {
  if (typeof value !== 'string') {
    throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', `${label} is missing`);
  }
  const decoded = Buffer.from(value, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/u, '');
  if (canonical !== value.replace(/=+$/u, '')) {
    throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', `${label} is not canonical base64`);
  }
  return decoded;
}

function manifestWithoutDigest(manifest: AnchorWorkspaceEvidenceManifest): Omit<AnchorWorkspaceEvidenceManifest, 'evidenceDigest'> {
  const { evidenceDigest: _ignored, ...rest } = manifest;
  return rest;
}

function computeEvidenceDigest(evidence: AnchorWorkspaceEvidence): string {
  return digestWorkspaceValue({
    manifest: manifestWithoutDigest(evidence.manifest),
    payload: evidence.payload,
  });
}

function assertNoHiddenTrackedState(listing: Buffer): void {
  for (const entry of listing.toString('utf8').split('\0').filter(Boolean)) {
    const tag = entry[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) {
      throw new AnchorEvidenceError(
        'TRACKED_STATE_HIDDEN',
        'assume-unchanged and skip-worktree entries cannot form complete anchor evidence',
      );
    }
  }
}

function assertNoIgnoredWorkspaceState(listing: Buffer): void {
  if (listing.byteLength > 0) {
    throw new AnchorEvidenceError(
      'IGNORED_WORKSPACE_STATE',
      'ignored workspace files are omitted by Git and cannot form complete anchor evidence',
    );
  }
}

async function readStableRegularFile(
  absolutePath: string,
  relativePath: string,
): Promise<{ bytes: Buffer; mode: number }> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw new AnchorEvidenceError(
      'UNSUPPORTED_UNTRACKED_ENTRY',
      `cannot open untracked file without following links (${relativePath}): ${String(error)}`,
    );
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new AnchorEvidenceError(
        'UNSUPPORTED_UNTRACKED_ENTRY',
        `untracked entry must be a regular file: ${relativePath}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const canonicalPath = await realpath(absolutePath);
    if (
      canonicalPath !== path.resolve(absolutePath)
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.mode !== after.mode
      || bytes.byteLength !== after.size
    ) {
      throw new AnchorEvidenceError(
        'ANCHOR_STATE_CHANGED',
        `untracked file changed during capture: ${relativePath}`,
      );
    }
    return { bytes, mode: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export class AnchorWorkspaceEvidenceService {
  private readonly runner: WorkspaceCommandRunner;
  private readonly now: () => number;
  private readonly maxPatchBytes: number;
  private readonly maxUntrackedBytes: number;
  private readonly maxUntrackedFiles: number;

  constructor(options: AnchorEvidenceServiceOptions = {}) {
    this.runner = options.runner ?? new NodeWorkspaceCommandRunner();
    this.now = options.now ?? Date.now;
    this.maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    this.maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
    this.maxUntrackedFiles = options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES;
  }

  async capture(input: CaptureAnchorWorkspaceEvidenceInput): Promise<AnchorWorkspaceEvidence> {
    const anchorId = input.anchorId.trim();
    if (!anchorId) {
      throw new AnchorEvidenceError('ANCHOR_ID_REQUIRED', 'anchorId is required');
    }
    const explicitBaseCommit = input.baseCommit.trim();
    if (!explicitBaseCommit) {
      throw new AnchorEvidenceError(
        'BASE_COMMIT_REQUIRED',
        'the anchor base commit must be supplied explicitly',
      );
    }
    if (!input.workspaceScopeVersion.trim()) {
      throw new AnchorEvidenceError('WORKSPACE_SCOPE_REQUIRED', 'workspaceScopeVersion is required');
    }
    if (input.pathMappings.length === 0) {
      throw new AnchorEvidenceError('PATH_MAPPING_INCOMPLETE', 'at least one path mapping is required');
    }

    const repositoryIdentity = await this.computeRepositoryIdentity(input.repositoryRoot);
    const baseCommitResult = await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--verify', `${explicitBaseCommit}^{commit}`],
      cwd: repositoryIdentity.canonicalRoot,
    }).catch((error: unknown) => {
      throw new AnchorEvidenceError(
        'BASE_COMMIT_INVALID',
        `the explicit anchor base commit cannot be resolved: ${String(error)}`,
      );
    });
    const baseCommit = baseCommitResult.stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(baseCommit)) {
      throw new AnchorEvidenceError('BASE_COMMIT_INVALID', 'git returned an invalid anchor commit id');
    }

    const observedHead = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--verify', 'HEAD'],
      cwd: repositoryIdentity.canonicalRoot,
    })).stdout.toString('utf8').trim();
    const pathMappings = await this.capturePathMappings(
      repositoryIdentity.canonicalRoot,
      input.pathMappings,
    );

    const [
      stagedPatch,
      unstagedPatch,
      untrackedResult,
      ignoredResult,
      unmergedResult,
      trackedFlagsResult,
    ] = await Promise.all([
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--cached', baseCommit, '--'],
        cwd: repositoryIdentity.canonicalRoot,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--'],
        cwd: repositoryIdentity.canonicalRoot,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--unmerged', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '-v', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
    ]);

    if (unmergedResult.stdout.byteLength > 0) {
      throw new AnchorEvidenceError(
        'EVIDENCE_INCOMPLETE',
        'cannot capture trustworthy anchor evidence with unmerged index entries',
      );
    }
    assertNoIgnoredWorkspaceState(ignoredResult.stdout);
    assertNoHiddenTrackedState(trackedFlagsResult.stdout);
    if (stagedPatch.byteLength > this.maxPatchBytes || unstagedPatch.byteLength > this.maxPatchBytes) {
      throw new AnchorEvidenceError('EVIDENCE_BUDGET_EXCEEDED', 'anchor patch exceeds the capture budget');
    }
    const untrackedPaths = untrackedResult.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => normalizeGitPath(entry, false))
      .sort((left, right) => left.localeCompare(right));
    if (untrackedPaths.length > this.maxUntrackedFiles) {
      throw new AnchorEvidenceError('EVIDENCE_BUDGET_EXCEEDED', 'too many untracked files at anchor');
    }

    const untrackedFiles: AnchorUntrackedFile[] = [];
    const untrackedBlobs: Record<string, string> = {};
    let untrackedBytes = 0;
    for (const relativePath of untrackedPaths) {
      const absolutePath = path.join(repositoryIdentity.canonicalRoot, ...relativePath.split('/'));
      const { bytes, mode } = await readStableRegularFile(absolutePath, relativePath);
      untrackedBytes += bytes.byteLength;
      if (untrackedBytes > this.maxUntrackedBytes) {
        throw new AnchorEvidenceError('EVIDENCE_BUDGET_EXCEEDED', 'untracked files exceed the capture budget');
      }
      const blobHash = sha256(bytes);
      untrackedFiles.push({
        path: relativePath,
        sha256: blobHash,
        sizeBytes: bytes.byteLength,
        mode,
      });
      untrackedBlobs[blobHash] = bytes.toString('base64');
    }

    const [
      finalHeadResult,
      finalStagedResult,
      finalUnstagedResult,
      finalUntrackedResult,
      finalIgnoredResult,
      finalUnmergedResult,
      finalTrackedFlagsResult,
    ] = await Promise.all([
      this.runner.run({
        executable: 'git',
        args: ['rev-parse', '--verify', 'HEAD'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--cached', baseCommit, '--'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--unmerged', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '-v', '-z'],
        cwd: repositoryIdentity.canonicalRoot,
      }),
    ]);
    assertNoIgnoredWorkspaceState(finalIgnoredResult.stdout);
    assertNoHiddenTrackedState(finalTrackedFlagsResult.stdout);
    if (
      finalHeadResult.stdout.toString('utf8').trim() !== observedHead
      || !finalStagedResult.stdout.equals(stagedPatch)
      || !finalUnstagedResult.stdout.equals(unstagedPatch)
      || !finalUntrackedResult.stdout.equals(untrackedResult.stdout)
      || !finalIgnoredResult.stdout.equals(ignoredResult.stdout)
      || finalUnmergedResult.stdout.byteLength > 0
      || !finalTrackedFlagsResult.stdout.equals(trackedFlagsResult.stdout)
    ) {
      throw new AnchorEvidenceError(
        'ANCHOR_STATE_CHANGED',
        'repository state changed while anchor evidence was being captured',
      );
    }
    for (const file of untrackedFiles) {
      const absolutePath = path.join(repositoryIdentity.canonicalRoot, ...file.path.split('/'));
      const finalRead = await readStableRegularFile(absolutePath, file.path).catch(() => {
        throw new AnchorEvidenceError(
          'ANCHOR_STATE_CHANGED',
          `untracked file changed during capture: ${file.path}`,
        );
      });
      if (
        finalRead.bytes.byteLength !== file.sizeBytes
        || sha256(finalRead.bytes) !== file.sha256
        || finalRead.mode !== file.mode
      ) {
        throw new AnchorEvidenceError(
          'ANCHOR_STATE_CHANGED',
          `untracked file changed during capture: ${file.path}`,
        );
      }
    }

    const manifest: AnchorWorkspaceEvidenceManifest = {
      version: 1,
      captureState: 'complete',
      anchorId,
      capturedAt: this.now(),
      baseCommit,
      baseCommitSource: 'explicit_anchor_input',
      observedHead,
      workspaceScopeVersion: input.workspaceScopeVersion.trim(),
      repositoryIdentity,
      pathMappings,
      stagedPatch: descriptor(stagedPatch),
      unstagedPatch: descriptor(unstagedPatch),
      untrackedFiles,
      evidenceDigest: '',
    };
    const evidence: AnchorWorkspaceEvidence = {
      manifest,
      payload: {
        stagedPatchBase64: stagedPatch.toString('base64'),
        unstagedPatchBase64: unstagedPatch.toString('base64'),
        untrackedBlobs,
      },
    };
    evidence.manifest.evidenceDigest = computeEvidenceDigest(evidence);
    await this.validateBundle(evidence);
    return evidence;
  }

  async validateBundle(evidence: AnchorWorkspaceEvidence): Promise<void> {
    if (
      !evidence
      || evidence.manifest?.version !== 1
      || evidence.manifest.captureState !== 'complete'
      || evidence.manifest.baseCommitSource !== 'explicit_anchor_input'
      || !evidence.manifest.anchorId
      || !evidence.manifest.workspaceScopeVersion
    ) {
      throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', 'anchor evidence manifest is incomplete');
    }
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(evidence.manifest.baseCommit)) {
      throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', 'anchor evidence has no resolved base commit');
    }
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(evidence.manifest.observedHead)) {
      throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', 'anchor evidence has no observed capture HEAD');
    }
    if (
      !evidence.manifest.repositoryIdentity?.canonicalRoot
      || !evidence.manifest.repositoryIdentity.canonicalGitCommonDirectory
      || !evidence.manifest.repositoryIdentity.fingerprint
    ) {
      throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', 'repository identity evidence is incomplete');
    }
    const {
      fingerprint: _fingerprint,
      ...repositoryIdentityFields
    } = evidence.manifest.repositoryIdentity;
    if (digestWorkspaceValue(repositoryIdentityFields) !== evidence.manifest.repositoryIdentity.fingerprint) {
      throw new AnchorEvidenceError('EVIDENCE_HASH_MISMATCH', 'repository identity fingerprint does not match');
    }
    this.validatePathMappings(evidence.manifest.pathMappings);

    const stagedPatch = decodeBase64(evidence.payload?.stagedPatchBase64, 'staged patch');
    const unstagedPatch = decodeBase64(evidence.payload?.unstagedPatchBase64, 'unstaged patch');
    this.assertDescriptor(stagedPatch, evidence.manifest.stagedPatch, 'staged patch');
    this.assertDescriptor(unstagedPatch, evidence.manifest.unstagedPatch, 'unstaged patch');

    const expectedBlobHashes = new Set<string>();
    let previousPath = '';
    for (const file of evidence.manifest.untrackedFiles) {
      const normalizedPath = normalizeGitPath(file.path, false);
      if (normalizedPath !== file.path || (previousPath && previousPath.localeCompare(file.path) >= 0)) {
        throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', 'untracked manifest paths are not stable and unique');
      }
      previousPath = file.path;
      if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !Number.isSafeInteger(file.mode)) {
        throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', `invalid untracked metadata: ${file.path}`);
      }
      const encodedBlob = evidence.payload.untrackedBlobs?.[file.sha256];
      if (typeof encodedBlob !== 'string') {
        throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', `missing untracked blob: ${file.path}`);
      }
      const blob = decodeBase64(encodedBlob, `untracked blob ${file.path}`);
      if (blob.byteLength !== file.sizeBytes || sha256(blob) !== file.sha256) {
        throw new AnchorEvidenceError('EVIDENCE_HASH_MISMATCH', `untracked blob does not match: ${file.path}`);
      }
      expectedBlobHashes.add(file.sha256);
    }
    const actualBlobHashes = Object.keys(evidence.payload.untrackedBlobs ?? {});
    if (
      actualBlobHashes.length !== expectedBlobHashes.size
      || actualBlobHashes.some((hash) => !expectedBlobHashes.has(hash))
    ) {
      throw new AnchorEvidenceError('EVIDENCE_INCOMPLETE', 'untracked blob set does not match the manifest');
    }
    if (computeEvidenceDigest(evidence) !== evidence.manifest.evidenceDigest) {
      throw new AnchorEvidenceError('EVIDENCE_HASH_MISMATCH', 'anchor evidence digest does not match');
    }
  }

  async assertRepositoryIdentity(
    evidence: AnchorWorkspaceEvidence,
    repositoryRoot: string,
  ): Promise<void> {
    await this.validateBundle(evidence);
    const currentIdentity = await this.computeRepositoryIdentity(repositoryRoot);
    if (currentIdentity.fingerprint !== evidence.manifest.repositoryIdentity.fingerprint) {
      throw new AnchorEvidenceError(
        'REPOSITORY_IDENTITY_DRIFT',
        'the repository identity no longer matches the anchor evidence',
      );
    }
  }

  async computeRepositoryIdentity(repositoryRoot: string): Promise<AnchorRepositoryIdentity> {
    if (!path.isAbsolute(repositoryRoot)) {
      throw new AnchorEvidenceError('REPOSITORY_IDENTITY_DRIFT', 'repository root must be absolute');
    }
    const canonicalRoot = await realpath(repositoryRoot).catch(() => {
      throw new AnchorEvidenceError('REPOSITORY_IDENTITY_DRIFT', 'repository root cannot be resolved');
    });
    const topLevel = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: canonicalRoot,
    })).stdout.toString('utf8').trim();
    const canonicalTopLevel = await realpath(topLevel);
    if (canonicalTopLevel !== canonicalRoot) {
      throw new AnchorEvidenceError(
        'REPOSITORY_IDENTITY_DRIFT',
        'repositoryRoot must identify the git top-level directory',
      );
    }
    const commonDirectoryOutput = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd: canonicalRoot,
    })).stdout.toString('utf8').trim();
    const canonicalGitCommonDirectory = await realpath(commonDirectoryOutput);
    const objectFormat = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--show-object-format'],
      cwd: canonicalRoot,
    })).stdout.toString('utf8').trim();
    const [rootStat, commonStat] = await Promise.all([
      stat(canonicalRoot),
      stat(canonicalGitCommonDirectory),
    ]);
    const identityFields = {
      canonicalRoot,
      canonicalGitCommonDirectory,
      rootDevice: String(rootStat.dev),
      rootInode: String(rootStat.ino),
      gitCommonDevice: String(commonStat.dev),
      gitCommonInode: String(commonStat.ino),
      objectFormat,
    };
    return {
      ...identityFields,
      fingerprint: digestWorkspaceValue(identityFields),
    };
  }

  private async capturePathMappings(
    repositoryRoot: string,
    mappings: CaptureAnchorWorkspaceEvidenceInput['pathMappings'],
  ): Promise<AnchorPathMapping[]> {
    const captured: AnchorPathMapping[] = [];
    const sourceIds = new Set<string>();
    for (const mapping of mappings) {
      const sourceId = mapping.sourceId.trim();
      if (!sourceId || sourceIds.has(sourceId)) {
        throw new AnchorEvidenceError('PATH_MAPPING_INVALID', 'path mapping source ids must be unique');
      }
      sourceIds.add(sourceId);
      const sourcePath = await realpath(mapping.sourcePath).catch(() => {
        throw new AnchorEvidenceError('PATH_MAPPING_INVALID', `source path cannot be resolved: ${mapping.sourcePath}`);
      });
      const relative = path.relative(repositoryRoot, sourcePath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new AnchorEvidenceError('PATH_MAPPING_INVALID', 'source path escapes the repository');
      }
      const repositoryRelativePath = relative
        ? normalizeGitPath(relative.split(path.sep).join('/'), false)
        : '.';
      captured.push({
        sourceId,
        sourcePath,
        repositoryRelativePath,
        isolatedRelativePath: normalizeGitPath(mapping.isolatedRelativePath, true),
      });
    }
    captured.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    this.validatePathMappings(captured);
    return captured;
  }

  private validatePathMappings(mappings: AnchorPathMapping[]): void {
    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new AnchorEvidenceError('PATH_MAPPING_INCOMPLETE', 'path mappings are missing');
    }
    const sourceIds = new Set<string>();
    let mapsRepositoryRoot = false;
    for (const mapping of mappings) {
      if (!mapping.sourceId || sourceIds.has(mapping.sourceId) || !path.isAbsolute(mapping.sourcePath)) {
        throw new AnchorEvidenceError('PATH_MAPPING_INVALID', 'path mapping is invalid');
      }
      sourceIds.add(mapping.sourceId);
      const repositoryRelativePath = normalizeGitPath(mapping.repositoryRelativePath, true);
      const isolatedRelativePath = normalizeGitPath(mapping.isolatedRelativePath, true);
      if (repositoryRelativePath !== mapping.repositoryRelativePath
        || isolatedRelativePath !== mapping.isolatedRelativePath) {
        throw new AnchorEvidenceError('PATH_MAPPING_INVALID', 'path mapping is not canonical');
      }
      if (repositoryRelativePath === '.' && isolatedRelativePath === '.') mapsRepositoryRoot = true;
    }
    if (!mapsRepositoryRoot) {
      throw new AnchorEvidenceError(
        'PATH_MAPPING_INCOMPLETE',
        'a repository-root to isolated-root mapping is required',
      );
    }
  }

  private assertDescriptor(
    bytes: Buffer,
    expected: AnchorPatchDescriptor | undefined,
    label: string,
  ): void {
    if (bytes.byteLength !== expected?.sizeBytes || sha256(bytes) !== expected.sha256) {
      throw new AnchorEvidenceError('EVIDENCE_HASH_MISMATCH', `${label} does not match its descriptor`);
    }
  }
}
