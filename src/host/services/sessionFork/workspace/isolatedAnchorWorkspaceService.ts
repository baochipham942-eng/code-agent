import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  AnchorEvidenceError,
  AnchorWorkspaceEvidenceService,
  digestWorkspaceValue,
} from './anchorEvidence';
import { NodeWorkspaceCommandRunner, WorkspaceCommandError } from './commandRunner';
import type {
  AnchorUntrackedFile,
  PrepareIsolatedAnchorWorkspaceInput,
  PreparedIsolatedAnchorWorkspace,
  WorkspaceCommandRunner,
  WorkspaceForkIntent,
  WorkspaceForkIntentStatus,
  WorkspaceForkIntentStore,
  WorkspaceRecoveryResult,
} from './types';

export type IsolatedWorkspaceErrorCode =
  | 'INVALID_DESTINATION'
  | 'INTENT_CONFLICT'
  | 'WORKSPACE_BUSY'
  | 'WORKSPACE_PREPARATION_FAILED'
  | 'WORKSPACE_VERIFICATION_FAILED'
  | 'WORKSPACE_CLEANUP_FAILED';

export class IsolatedWorkspaceError extends Error {
  constructor(
    public readonly code: IsolatedWorkspaceErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'IsolatedWorkspaceError';
  }
}

interface IsolatedAnchorWorkspaceServiceOptions {
  durableRoot: string;
  intentStore: WorkspaceForkIntentStore;
  runner?: WorkspaceCommandRunner;
  evidenceService?: AnchorWorkspaceEvidenceService;
  now?: () => number;
  /** Deterministic fault-injection hook; production callers leave this undefined. */
  workspacePublishBarrier?: (input: {
    intentId: string;
    stagingWorkspacePath: string;
    workspacePath: string;
    relativePaths: readonly string[];
  }) => void | Promise<void>;
}

const GIT_BASE85_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function gitBlobOid(blob: Buffer, objectFormat: string): string {
  const hashAlgorithm = objectFormat === 'sha1'
    ? 'sha1'
    : objectFormat === 'sha256'
      ? 'sha256'
      : null;
  if (!hashAlgorithm) {
    throw new IsolatedWorkspaceError(
      'WORKSPACE_PREPARATION_FAILED',
      `unsupported git object format: ${objectFormat}`,
    );
  }
  return createHash(hashAlgorithm).update(`blob ${blob.byteLength}\0`).update(blob).digest('hex');
}

function quoteGitPatchPath(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += '\\\\';
    else if (byte === 0x09) quoted += '\\t';
    else if (byte === 0x0a) quoted += '\\n';
    else if (byte === 0x0d) quoted += '\\r';
    else if (byte >= 0x20 && byte <= 0x7e) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}

function encodeGitBase85(value: Buffer): string {
  const compressed = deflateSync(value);
  const lines: string[] = [];
  for (let offset = 0; offset < compressed.byteLength; offset += 52) {
    const line = compressed.subarray(offset, Math.min(offset + 52, compressed.byteLength));
    const lengthMarker = line.byteLength <= 26
      ? String.fromCharCode(0x41 + line.byteLength - 1)
      : String.fromCharCode(0x61 + line.byteLength - 27);
    let encoded = '';
    for (let index = 0; index < line.byteLength; index += 4) {
      let accumulator = 0;
      for (let byteOffset = 0; byteOffset < 4; byteOffset += 1) {
        accumulator = (accumulator * 256) + (line[index + byteOffset] ?? 0);
      }
      const digits = new Array<string>(5);
      for (let digit = 4; digit >= 0; digit -= 1) {
        digits[digit] = GIT_BASE85_ALPHABET[accumulator % 85];
        accumulator = Math.floor(accumulator / 85);
      }
      encoded += digits.join('');
    }
    lines.push(`${lengthMarker}${encoded}`);
  }
  return lines.join('\n');
}

function errorCode(error: unknown): string {
  if (error instanceof AnchorEvidenceError) return error.code;
  if (error instanceof WorkspaceCommandError) return error.code;
  if (error instanceof IsolatedWorkspaceError) return error.code;
  return 'UNKNOWN';
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function resultFromIntent(intent: WorkspaceForkIntent): PreparedIsolatedAnchorWorkspace {
  if ((intent.status !== 'ready' && intent.status !== 'advertised') || !intent.advertisable) {
    throw new IsolatedWorkspaceError('WORKSPACE_VERIFICATION_FAILED', 'workspace intent is not ready');
  }
  return {
    intentId: intent.intentId,
    status: 'ready',
    advertisable: true,
    workspacePath: intent.workspacePath,
    baseCommit: intent.evidence.manifest.baseCommit,
    evidenceDigest: intent.evidenceDigest,
    workspaceScopeVersion: intent.evidence.manifest.workspaceScopeVersion,
    pathMappings: intent.evidence.manifest.pathMappings.map((mapping) => ({
      ...mapping,
      isolatedPath: path.resolve(
        intent.workspacePath,
        ...mapping.isolatedRelativePath.split('/').filter((part) => part !== '.'),
      ),
    })),
  };
}

const workspaceOperationLocks = new Map<string, Promise<unknown>>();

export class IsolatedAnchorWorkspaceService {
  private readonly durableRoot: string;
  private readonly intentStore: WorkspaceForkIntentStore;
  private readonly runner: WorkspaceCommandRunner;
  private readonly evidenceService: AnchorWorkspaceEvidenceService;
  private readonly now: () => number;
  private readonly workspacePublishBarrier?: IsolatedAnchorWorkspaceServiceOptions['workspacePublishBarrier'];

  constructor(options: IsolatedAnchorWorkspaceServiceOptions) {
    if (!path.isAbsolute(options.durableRoot)) {
      throw new IsolatedWorkspaceError('INVALID_DESTINATION', 'durableRoot must be absolute');
    }
    this.durableRoot = path.resolve(options.durableRoot);
    this.intentStore = options.intentStore;
    this.runner = options.runner ?? new NodeWorkspaceCommandRunner();
    this.evidenceService = options.evidenceService ?? new AnchorWorkspaceEvidenceService({
      runner: this.runner,
    });
    this.now = options.now ?? Date.now;
    this.workspacePublishBarrier = options.workspacePublishBarrier;
  }

  async prepare(input: PrepareIsolatedAnchorWorkspaceInput): Promise<PreparedIsolatedAnchorWorkspace> {
    const workspacePath = this.resolveDestination(input.destinationName);
    return await this.withWorkspaceOperation(workspacePath, async () => {
      return await this.prepareLocked(input, workspacePath);
    });
  }

  private async prepareLocked(
    input: PrepareIsolatedAnchorWorkspaceInput,
    workspacePath: string,
  ): Promise<PreparedIsolatedAnchorWorkspace> {
    // These checks intentionally happen before an intent is persisted. Invalid or
    // incomplete evidence must be a zero-write operation.
    await this.evidenceService.validateBundle(input.evidence);
    await this.evidenceService.assertRepositoryIdentity(input.evidence, input.repositoryRoot);

    const normalizedRequest = {
      intentId: input.intentId.trim(),
      sourceSessionId: input.sourceSessionId.trim(),
      proposedChildSessionId: input.proposedChildSessionId.trim(),
      repositoryRoot: input.evidence.manifest.repositoryIdentity.canonicalRoot,
      workspacePath,
      evidenceDigest: input.evidence.manifest.evidenceDigest,
    };
    if (
      !normalizedRequest.intentId
      || !normalizedRequest.sourceSessionId
      || !normalizedRequest.proposedChildSessionId
    ) {
      throw new IsolatedWorkspaceError('INTENT_CONFLICT', 'intent and session identities are required');
    }
    const requestDigest = digestWorkspaceValue(normalizedRequest);
    let intent = await this.intentStore.get(normalizedRequest.intentId);
    if (intent && intent.requestDigest !== requestDigest) {
      throw new IsolatedWorkspaceError('INTENT_CONFLICT', 'idempotency intent was reused with another request');
    }
    if (!intent) {
      const existingOwner = (await this.intentStore.list()).find((candidate) => (
        candidate.intentId !== normalizedRequest.intentId
        && candidate.workspacePath === workspacePath
        && candidate.status !== 'abandoned'
      ));
      if (existingOwner) {
        throw new IsolatedWorkspaceError(
          'INTENT_CONFLICT',
          `workspace destination is already owned by intent ${existingOwner.intentId}`,
        );
      }
      if (await this.pathExists(workspacePath)) {
        throw new IsolatedWorkspaceError(
          'INVALID_DESTINATION',
          'refusing to claim an existing durable workspace path',
        );
      }
      const now = this.now();
      intent = await this.intentStore.create({
        version: 1,
        revision: 0,
        intentId: normalizedRequest.intentId,
        requestDigest,
        sourceSessionId: normalizedRequest.sourceSessionId,
        proposedChildSessionId: normalizedRequest.proposedChildSessionId,
        repositoryRoot: normalizedRequest.repositoryRoot,
        workspacePath,
        evidence: structuredClone(input.evidence),
        evidenceDigest: input.evidence.manifest.evidenceDigest,
        status: 'recorded',
        advertisable: false,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (intent.status === 'ready') {
      try {
        await this.verifyWorkspace(intent, intent.workspacePath);
        return resultFromIntent(intent);
      } catch (error) {
        const failed = await this.intentStore.update(intent.intentId, intent.revision, {
          status: 'cleanup_required',
          advertisable: false,
          lastError: {
            code: errorCode(error),
            message: errorMessage(error),
            at: this.now(),
          },
          updatedAt: this.now(),
        });
        throw new IsolatedWorkspaceError(
          'WORKSPACE_VERIFICATION_FAILED',
          `ready workspace no longer matches its anchor seal: ${failed.lastError?.message ?? 'unknown'}`,
          error,
        );
      }
    }
    if (intent.status === 'advertised') return resultFromIntent(intent);
    if (intent.status === 'abandoned') {
      throw new IsolatedWorkspaceError('INTENT_CONFLICT', 'abandoned intent cannot be reused');
    }
    return await this.drive(intent);
  }

  async recoverIncomplete(input: {
    strategy: 'resume' | 'cleanup';
  }): Promise<WorkspaceRecoveryResult[]> {
    const intents = (await this.intentStore.list()).filter(
      (intent) => (
        intent.status !== 'ready'
        && intent.status !== 'advertised'
        && intent.status !== 'abandoned'
      ),
    );
    const results: WorkspaceRecoveryResult[] = [];
    for (const discoveredIntent of intents) {
      const result = await this.recoverIntent(discoveredIntent.intentId, input);
      results.push(result);
    }
    return results;
  }

  async recoverIntent(
    intentId: string,
    input: { strategy: 'resume' | 'cleanup' },
  ): Promise<WorkspaceRecoveryResult> {
    const discoveredIntent = await this.intentStore.get(intentId);
    if (!discoveredIntent) {
      return {
        intentId,
        outcome: 'cleaned',
        workspacePath: '',
      };
    }
    return await this.withWorkspaceOperation(discoveredIntent.workspacePath, async () => {
      let intent = await this.intentStore.get(discoveredIntent.intentId) ?? discoveredIntent;
      try {
        if (intent.status === 'abandoned') {
          return {
            intentId: intent.intentId,
            outcome: 'cleaned' as const,
            workspacePath: intent.workspacePath,
          };
        }
        if (input.strategy === 'cleanup') {
          await this.cleanupWorkspace(intent);
          intent = await this.transition(intent, 'abandoned', { advertisable: false });
          return {
            intentId: intent.intentId,
            outcome: 'cleaned' as const,
            workspacePath: intent.workspacePath,
          };
        }
        if (intent.status === 'advertised') {
          await this.verifyWorkspace(intent, intent.workspacePath);
          return {
            intentId: intent.intentId,
            outcome: 'ready' as const,
            workspacePath: intent.workspacePath,
          };
        }
        if (intent.status === 'ready') {
          await this.verifyWorkspace(intent, intent.workspacePath);
          return {
            intentId: intent.intentId,
            outcome: 'ready' as const,
            workspacePath: intent.workspacePath,
          };
        }

        const stagingWorkspacePath = this.resolveStagingWorkspacePath(intent);
        if (
          intent.status !== 'recorded'
          || await this.pathExists(intent.workspacePath)
          || await this.pathExists(stagingWorkspacePath)
        ) {
          await this.cleanupWorkspace(intent);
          intent = await this.transition(intent, 'recorded', {
            advertisable: false,
            lastError: undefined,
          });
        }
        const prepared = await this.drive(intent);
        return {
          intentId: intent.intentId,
          outcome: 'ready' as const,
          workspacePath: prepared.workspacePath,
        };
      } catch (error) {
        return {
          intentId: intent.intentId,
          outcome: 'failed' as const,
          workspacePath: intent.workspacePath,
          error: errorMessage(error),
        };
      }
    });
  }

  /**
   * The application calls this only after the child session commit succeeds.
   * From this point the workspace is allowed to evolve with the child and is
   * excluded from preparation recovery/cleanup.
   */
  async markAdvertised(intentId: string): Promise<PreparedIsolatedAnchorWorkspace> {
    const discovered = await this.intentStore.get(intentId);
    if (!discovered) {
      throw new IsolatedWorkspaceError('INTENT_CONFLICT', `intent ${intentId} does not exist`);
    }
    return await this.withWorkspaceOperation(discovered.workspacePath, async () => {
      let intent = await this.intentStore.get(intentId);
      if (!intent) {
        throw new IsolatedWorkspaceError('INTENT_CONFLICT', `intent ${intentId} does not exist`);
      }
      if (intent.status === 'advertised') return resultFromIntent(intent);
      if (intent.status !== 'ready' || !intent.advertisable) {
        throw new IsolatedWorkspaceError('INTENT_CONFLICT', 'only a verified ready intent can be advertised');
      }
      await this.verifyWorkspace(intent, intent.workspacePath);
      intent = await this.transition(intent, 'advertised', { advertisable: true });
      return resultFromIntent(intent);
    });
  }

  /**
   * Recovery uses this form so the final filesystem seal and the database
   * publication run under the same workspace operation lock.
   */
  async advertiseAndFinalize<T>(
    intentId: string,
    finalize: (workspace: PreparedIsolatedAnchorWorkspace) => T | Promise<T>,
  ): Promise<T> {
    const discovered = await this.intentStore.get(intentId);
    if (!discovered) {
      throw new IsolatedWorkspaceError('INTENT_CONFLICT', `intent ${intentId} does not exist`);
    }
    return await this.withWorkspaceOperation(discovered.workspacePath, async () => {
      let intent = await this.intentStore.get(intentId);
      if (!intent) {
        throw new IsolatedWorkspaceError('INTENT_CONFLICT', `intent ${intentId} does not exist`);
      }
      if (intent.status !== 'ready' && intent.status !== 'advertised') {
        throw new IsolatedWorkspaceError(
          'INTENT_CONFLICT',
          'only a verified ready or crash-window advertised intent can be finalized',
        );
      }
      await this.verifyWorkspace(intent, intent.workspacePath);
      if (intent.status === 'ready') {
        intent = await this.transition(intent, 'advertised', { advertisable: true });
      }
      return await finalize(resultFromIntent(intent));
    });
  }

  private async drive(initialIntent: WorkspaceForkIntent): Promise<PreparedIsolatedAnchorWorkspace> {
    let intent = initialIntent;
    try {
      if (intent.status === 'cleanup_required') {
        await this.cleanupWorkspace(intent);
        intent = await this.transition(intent, 'recorded', { advertisable: false });
      }
      if (intent.status === 'recorded') {
        await this.createWorktree(intent);
        intent = await this.transition(intent, 'worktree_created', {
          advertisable: false,
          attempts: intent.attempts + 1,
          lastError: undefined,
        });
      }
      if (intent.status === 'worktree_created') {
        intent = await this.transition(intent, 'applying', { advertisable: false });
        await this.applyEvidence(intent, this.resolveStagingWorkspacePath(intent));
        intent = await this.transition(intent, 'evidence_applied', { advertisable: false });
      }
      if (intent.status === 'applying') {
        throw new IsolatedWorkspaceError(
          'WORKSPACE_PREPARATION_FAILED',
          'an interrupted apply must be rebuilt through recovery',
        );
      }
      if (intent.status === 'evidence_applied') {
        intent = await this.transition(intent, 'verifying', { advertisable: false });
        const stagingWorkspacePath = this.resolveStagingWorkspacePath(intent);
        await this.verifyWorkspace(intent, stagingWorkspacePath);
        await this.publishWorkspace(intent, stagingWorkspacePath);
        await this.verifyWorkspace(intent, intent.workspacePath);
        intent = await this.transition(intent, 'ready', {
          advertisable: true,
          lastError: undefined,
        });
      }
      if (intent.status === 'verifying') {
        throw new IsolatedWorkspaceError(
          'WORKSPACE_VERIFICATION_FAILED',
          'an interrupted verification must be rebuilt through recovery',
        );
      }
      return resultFromIntent(intent);
    } catch (error) {
      const current = await this.intentStore.get(intent.intentId);
      if (current && current.status !== 'ready' && current.status !== 'abandoned') {
        await this.intentStore.update(current.intentId, current.revision, {
          status: 'cleanup_required',
          advertisable: false,
          lastError: {
            code: errorCode(error),
            message: errorMessage(error),
            at: this.now(),
          },
          updatedAt: this.now(),
        }).catch(() => undefined);
      }
      if (error instanceof AnchorEvidenceError) throw error;
      throw new IsolatedWorkspaceError(
        'WORKSPACE_PREPARATION_FAILED',
        `failed to reconstruct anchor workspace: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async createWorktree(intent: WorkspaceForkIntent): Promise<void> {
    await mkdir(this.durableRoot, { recursive: true, mode: 0o700 });
    const stagingWorkspacePath = this.resolveStagingWorkspacePath(intent);
    await mkdir(path.dirname(stagingWorkspacePath), { recursive: true, mode: 0o700 });
    if (
      await this.pathExists(intent.workspacePath)
      || await this.pathExists(stagingWorkspacePath)
    ) {
      throw new IsolatedWorkspaceError('INVALID_DESTINATION', 'workspace destination already exists');
    }
    await this.runner.run({
      executable: 'git',
      args: [
        'worktree',
        'add',
        '--detach',
        stagingWorkspacePath,
        intent.evidence.manifest.baseCommit,
      ],
      cwd: intent.repositoryRoot,
      timeoutMs: 60_000,
    });
    await this.assertRegisteredWorkspaceRoot(intent, stagingWorkspacePath);
  }

  private async applyEvidence(
    intent: WorkspaceForkIntent,
    workspacePath: string,
  ): Promise<void> {
    await this.assertRegisteredWorkspaceRoot(intent, workspacePath);
    const stagedPatch = Buffer.from(intent.evidence.payload.stagedPatchBase64, 'base64');
    if (stagedPatch.byteLength > 0) {
      await this.runner.run({
        executable: 'git',
        args: ['apply', '--binary', '--index', '--whitespace=nowarn', '-'],
        cwd: workspacePath,
        input: stagedPatch,
      });
      await this.assertRegisteredWorkspaceRoot(intent, workspacePath);
    }
    const unstagedPatch = Buffer.from(intent.evidence.payload.unstagedPatchBase64, 'base64');
    if (unstagedPatch.byteLength > 0) {
      await this.runner.run({
        executable: 'git',
        args: ['apply', '--binary', '--whitespace=nowarn', '-'],
        cwd: workspacePath,
        input: unstagedPatch,
      });
      await this.assertRegisteredWorkspaceRoot(intent, workspacePath);
    }
    await this.restoreUntrackedFiles(intent, workspacePath);
  }

  private async restoreUntrackedFiles(
    intent: WorkspaceForkIntent,
    workspacePath: string,
  ): Promise<void> {
    const files = intent.evidence.manifest.untrackedFiles;
    if (files.length === 0) return;
    await this.assertUntrackedAncestorsSafe(intent, workspacePath);

    // Git validates the complete patch before checkout and rejects any path
    // whose leading component became a symlink. Keeping the blob batch in
    // memory avoids opening a destination through a raced ancestor in JS.
    const patch = Buffer.from(files.map((file) => {
      return this.buildUntrackedFilePatch(intent, file);
    }).join(''), 'utf8');
    await this.runner.run({
      executable: 'git',
      args: ['apply', '--binary', '--whitespace=nowarn', '-'],
      cwd: workspacePath,
      input: patch,
    });
    await this.assertRegisteredWorkspaceRoot(intent, workspacePath);
    for (const file of files) {
      await this.verifyUntrackedFileHandle(intent, file, workspacePath, { applyMode: true });
    }
  }

  private buildUntrackedFilePatch(
    intent: WorkspaceForkIntent,
    file: AnchorUntrackedFile,
  ): string {
    const blob = Buffer.from(intent.evidence.payload.untrackedBlobs[file.sha256], 'base64');
    if (
      blob.byteLength !== file.sizeBytes
      || sha256(blob) !== file.sha256
      || file.mode < 0
      || (file.mode & ~0o777) !== 0
    ) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_PREPARATION_FAILED',
        `untracked evidence changed before reconstruction: ${file.path}`,
      );
    }
    const objectFormat = intent.evidence.manifest.repositoryIdentity.objectFormat;
    const objectId = gitBlobOid(blob, objectFormat);
    const zeroObjectId = '0'.repeat(objectId.length);
    const gitMode = (file.mode & 0o111) === 0 ? '100644' : '100755';
    return [
      `diff --git ${quoteGitPatchPath(`a/${file.path}`)} ${quoteGitPatchPath(`b/${file.path}`)}`,
      `new file mode ${gitMode}`,
      `index ${zeroObjectId}..${objectId}`,
      'GIT binary patch',
      `literal ${blob.byteLength}`,
      encodeGitBase85(blob),
      '',
      '',
    ].join('\n');
  }

  private async assertUntrackedAncestorsSafe(
    intent: WorkspaceForkIntent,
    workspacePath: string,
  ): Promise<void> {
    for (const file of intent.evidence.manifest.untrackedFiles) {
      const parts = file.path.split('/');
      let current = workspacePath;
      for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        try {
          const currentStat = await lstat(current);
          if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
            throw new IsolatedWorkspaceError(
              'WORKSPACE_PREPARATION_FAILED',
              `untracked file ancestor is not a safe directory: ${file.path}`,
            );
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
      }
    }
  }

  private async verifyUntrackedFileHandle(
    intent: WorkspaceForkIntent,
    file: AnchorUntrackedFile,
    workspacePath: string,
    input: { applyMode: boolean },
  ): Promise<void> {
    const target = this.resolveWithinWorkspace(workspacePath, file.path);
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const [canonicalWorkspacePath, canonicalTarget, pathStat, handleStat] = await Promise.all([
        realpath(workspacePath),
        realpath(target),
        lstat(target),
        handle.stat(),
      ]);
      const relative = path.relative(canonicalWorkspacePath, canonicalTarget);
      if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || !pathStat.isFile()
        || pathStat.isSymbolicLink()
        || !handleStat.isFile()
        || handleStat.isSymbolicLink()
        || pathStat.dev !== handleStat.dev
        || pathStat.ino !== handleStat.ino
      ) {
        throw new IsolatedWorkspaceError(
          'WORKSPACE_PREPARATION_FAILED',
          `untracked file did not resolve to its isolated workspace inode: ${file.path}`,
        );
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== file.sha256) {
        throw new IsolatedWorkspaceError(
          input.applyMode ? 'WORKSPACE_PREPARATION_FAILED' : 'WORKSPACE_VERIFICATION_FAILED',
          `isolated untracked file differs from evidence: ${file.path}`,
        );
      }
      if (input.applyMode && (handleStat.mode & 0o777) !== file.mode) {
        await handle.chmod(file.mode);
      }
      const finalStat = await handle.stat();
      if ((finalStat.mode & 0o777) !== file.mode) {
        throw new IsolatedWorkspaceError(
          input.applyMode ? 'WORKSPACE_PREPARATION_FAILED' : 'WORKSPACE_VERIFICATION_FAILED',
          `isolated untracked file mode differs from evidence: ${file.path}`,
        );
      }
    } finally {
      await handle.close();
    }
  }

  private async verifyWorkspace(
    intent: WorkspaceForkIntent,
    workspacePath: string,
  ): Promise<void> {
    await this.assertRegisteredWorkspaceRoot(intent, workspacePath);
    const head = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--verify', 'HEAD'],
      cwd: workspacePath,
    })).stdout.toString('utf8').trim();
    if (head !== intent.evidence.manifest.baseCommit) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        'isolated worktree HEAD differs from the explicit anchor base commit',
      );
    }

    const [staged, unstaged, untracked] = await Promise.all([
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--cached', intent.evidence.manifest.baseCommit, '--'],
        cwd: workspacePath,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--'],
        cwd: workspacePath,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        cwd: workspacePath,
      }).then((result) => result.stdout),
    ]);
    this.assertPatch(staged, intent.evidence.manifest.stagedPatch, 'staged');
    this.assertPatch(unstaged, intent.evidence.manifest.unstagedPatch, 'unstaged');

    const untrackedPaths = untracked.toString('utf8').split('\0').filter(Boolean).sort();
    const expectedPaths = intent.evidence.manifest.untrackedFiles.map((file) => file.path);
    if (JSON.stringify(untrackedPaths) !== JSON.stringify(expectedPaths)) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        'isolated worktree untracked manifest differs from anchor evidence',
      );
    }
    for (const expected of intent.evidence.manifest.untrackedFiles) {
      await this.verifyUntrackedFileHandle(intent, expected, workspacePath, { applyMode: false });
    }
    await this.assertRegisteredWorkspaceRoot(intent, workspacePath);
  }

  private async publishWorkspace(
    intent: WorkspaceForkIntent,
    stagingWorkspacePath: string,
  ): Promise<void> {
    await this.assertRegisteredWorkspaceRoot(intent, stagingWorkspacePath);
    if (await this.pathExists(intent.workspacePath)) {
      throw new IsolatedWorkspaceError(
        'INVALID_DESTINATION',
        'workspace destination appeared before staged workspace publication',
      );
    }
    await this.workspacePublishBarrier?.({
      intentId: intent.intentId,
      stagingWorkspacePath,
      workspacePath: intent.workspacePath,
      relativePaths: intent.evidence.manifest.untrackedFiles.map((file) => file.path),
    });
    await this.assertRegisteredWorkspaceRoot(intent, stagingWorkspacePath);
    if (await this.pathExists(intent.workspacePath)) {
      throw new IsolatedWorkspaceError(
        'INVALID_DESTINATION',
        'workspace destination changed during staged workspace publication',
      );
    }
    await this.runner.run({
      executable: 'git',
      args: ['worktree', 'move', stagingWorkspacePath, intent.workspacePath],
      cwd: intent.repositoryRoot,
      timeoutMs: 60_000,
    });
    await this.assertRegisteredWorkspaceRoot(intent, intent.workspacePath);
  }

  private async assertRegisteredWorkspaceRoot(
    intent: WorkspaceForkIntent,
    workspacePath: string,
  ): Promise<void> {
    this.assertWithinDurableRoot(workspacePath);
    const rootStat = await lstat(workspacePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        'isolated worktree root is not a no-follow directory',
      );
    }
    const [canonicalDurableRoot, canonicalWorkspacePath] = await Promise.all([
      realpath(this.durableRoot),
      realpath(workspacePath),
    ]);
    const durableRelative = path.relative(canonicalDurableRoot, canonicalWorkspacePath);
    if (
      !durableRelative
      || durableRelative === '..'
      || durableRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(durableRelative)
    ) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        'isolated worktree root resolves outside durableRoot',
      );
    }
    const topLevel = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: workspacePath,
    })).stdout.toString('utf8').trim();
    const canonicalTopLevel = await realpath(topLevel);
    if (canonicalTopLevel !== canonicalWorkspacePath) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        'isolated worktree root no longer matches Git worktree identity',
      );
    }
    const worktreeList = (await this.runner.run({
      executable: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: intent.repositoryRoot,
    })).stdout.toString('utf8');
    const registeredPaths = worktreeList
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    const canonicalRegisteredPaths = await Promise.all(registeredPaths.map(async (registeredPath) => {
      return await realpath(registeredPath).catch(() => path.resolve(registeredPath));
    }));
    if (!canonicalRegisteredPaths.includes(canonicalWorkspacePath)) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        'isolated worktree root is not registered by its source repository',
      );
    }
  }

  private async cleanupWorkspace(intent: WorkspaceForkIntent): Promise<void> {
    const worktreeList = (await this.runner.run({
      executable: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: intent.repositoryRoot,
    })).stdout.toString('utf8');
    const registeredPaths = worktreeList
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    const canonicalRegisteredPaths = await Promise.all(registeredPaths.map(async (registeredPath) => {
      return await realpath(registeredPath).catch(() => path.resolve(registeredPath));
    }));
    const canonicalDurableRoot = await realpath(this.durableRoot);
    const candidates = [
      this.resolveStagingWorkspacePath(intent),
      intent.workspacePath,
    ];
    const cleanupErrors: string[] = [];
    for (const candidate of candidates) {
      this.assertWithinDurableRoot(candidate);
      if (!await this.pathExists(candidate)) continue;
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        cleanupErrors.push(`refusing to clean non-directory workspace path: ${candidate}`);
        continue;
      }
      const canonicalCandidate = await realpath(candidate);
      const durableRelative = path.relative(canonicalDurableRoot, canonicalCandidate);
      if (
        !durableRelative
        || durableRelative === '..'
        || durableRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(durableRelative)
      ) {
        cleanupErrors.push(`refusing to clean workspace outside durableRoot: ${candidate}`);
        continue;
      }
      if (!canonicalRegisteredPaths.includes(canonicalCandidate)) {
        cleanupErrors.push(`refusing to clean unregistered workspace path: ${candidate}`);
        continue;
      }
      await this.runner.run({
        executable: 'git',
        args: ['worktree', 'remove', '--force', candidate],
        cwd: intent.repositoryRoot,
        timeoutMs: 60_000,
      });
    }
    if (cleanupErrors.length > 0) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_CLEANUP_FAILED',
        cleanupErrors.join('; '),
      );
    }
  }

  private resolveStagingWorkspacePath(intent: WorkspaceForkIntent): string {
    const stagingDirectory = path.join(this.durableRoot, '.neo-session-fork-staging');
    const stagingName = digestWorkspaceValue({
      intentId: intent.intentId,
      requestDigest: intent.requestDigest,
    }).slice(0, 40);
    const stagingWorkspacePath = path.join(stagingDirectory, stagingName);
    this.assertWithinDurableRoot(stagingWorkspacePath);
    return stagingWorkspacePath;
  }

  private resolveDestination(destinationName: string): string {
    const trimmed = destinationName.trim();
    if (
      !trimmed
      || trimmed === '.'
      || trimmed === '..'
      || trimmed.includes('/')
      || trimmed.includes('\\')
      || trimmed.includes('\0')
    ) {
      throw new IsolatedWorkspaceError('INVALID_DESTINATION', 'destinationName must be one safe path segment');
    }
    const destination = path.resolve(this.durableRoot, trimmed);
    this.assertWithinDurableRoot(destination);
    return destination;
  }

  private resolveWithinWorkspace(workspacePath: string, gitRelativePath: string): string {
    if (
      !gitRelativePath
      || gitRelativePath.includes('\0')
      || gitRelativePath.includes('\\')
      || path.posix.isAbsolute(gitRelativePath)
    ) {
      throw new IsolatedWorkspaceError('WORKSPACE_VERIFICATION_FAILED', 'unsafe evidence path');
    }
    const destination = path.resolve(workspacePath, ...gitRelativePath.split('/'));
    const relative = path.relative(workspacePath, destination);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new IsolatedWorkspaceError('WORKSPACE_VERIFICATION_FAILED', 'evidence path escapes workspace');
    }
    return destination;
  }

  private assertWithinDurableRoot(candidate: string): void {
    const relative = path.relative(this.durableRoot, path.resolve(candidate));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new IsolatedWorkspaceError('INVALID_DESTINATION', 'workspace path escapes durableRoot');
    }
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private assertPatch(
    patch: Buffer,
    descriptor: { sha256: string; sizeBytes: number },
    label: string,
  ): void {
    if (patch.byteLength !== descriptor.sizeBytes || sha256(patch) !== descriptor.sha256) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_VERIFICATION_FAILED',
        `${label} patch differs from anchor evidence`,
      );
    }
  }

  private async transition(
    intent: WorkspaceForkIntent,
    status: WorkspaceForkIntentStatus,
    patch: Partial<WorkspaceForkIntent>,
  ): Promise<WorkspaceForkIntent> {
    return await this.intentStore.update(intent.intentId, intent.revision, {
      ...patch,
      status,
      updatedAt: this.now(),
    });
  }

  private async withWorkspaceOperation<T>(
    workspacePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = path.resolve(workspacePath);
    const previous = workspaceOperationLocks.get(lockKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const release = await this.acquireWorkspaceFileLock(lockKey);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
    workspaceOperationLocks.set(lockKey, next);
    try {
      return await next;
    } finally {
      if (workspaceOperationLocks.get(lockKey) === next) workspaceOperationLocks.delete(lockKey);
    }
  }

  private async acquireWorkspaceFileLock(workspacePath: string): Promise<() => Promise<void>> {
    const lockDirectory = path.join(this.durableRoot, '.neo-session-fork-locks');
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(lockDirectory, `${digestWorkspaceValue(workspacePath)}.lock`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, workspacePath }));
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        return async () => {
          await handle.close();
          const current = await readFile(lockPath, 'utf8').catch(() => '');
          if (current.includes(`"token":"${token}"`)) {
            await unlink(lockPath).catch(() => undefined);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = await readFile(lockPath, 'utf8').catch(() => '');
        const ownerPid = (() => {
          try {
            return Number((JSON.parse(current) as { pid?: unknown }).pid);
          } catch {
            return 0;
          }
        })();
        let ownerAlive = ownerPid > 0;
        if (ownerPid === process.pid) {
          // In-process operations are already serialized by workspaceOperationLocks.
          ownerAlive = false;
        } else if (ownerAlive) {
          try {
            process.kill(ownerPid, 0);
          } catch (killError) {
            ownerAlive = (killError as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }
        if (ownerAlive) {
          throw new IsolatedWorkspaceError(
            'WORKSPACE_BUSY',
            `workspace preparation is owned by live process ${ownerPid}`,
          );
        }
        await unlink(lockPath).catch((unlinkError: unknown) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new IsolatedWorkspaceError('WORKSPACE_BUSY', 'cannot acquire workspace preparation lock');
  }
}
