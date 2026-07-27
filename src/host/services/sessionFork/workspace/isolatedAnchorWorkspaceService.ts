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
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string {
  if (error instanceof AnchorEvidenceError) return error.code;
  if (error instanceof WorkspaceCommandError) return error.code;
  if (error instanceof IsolatedWorkspaceError) return error.code;
  return 'UNKNOWN';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
        await this.verifyWorkspace(intent);
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
      const result = await this.withWorkspaceOperation(discoveredIntent.workspacePath, async () => {
        let intent = await this.intentStore.get(discoveredIntent.intentId) ?? discoveredIntent;
        try {
          if (intent.status === 'ready' || intent.status === 'advertised') {
            return {
              intentId: intent.intentId,
              outcome: 'ready' as const,
              workspacePath: intent.workspacePath,
            };
          }
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

          if (intent.status !== 'recorded' || await this.pathExists(intent.workspacePath)) {
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
      results.push(result);
    }
    return results;
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
      await this.verifyWorkspace(intent);
      intent = await this.transition(intent, 'advertised', { advertisable: true });
      return resultFromIntent(intent);
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
        await this.applyEvidence(intent);
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
        await this.verifyWorkspace(intent);
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
    if (await this.pathExists(intent.workspacePath)) {
      throw new IsolatedWorkspaceError('INVALID_DESTINATION', 'workspace destination already exists');
    }
    await this.runner.run({
      executable: 'git',
      args: [
        'worktree',
        'add',
        '--detach',
        intent.workspacePath,
        intent.evidence.manifest.baseCommit,
      ],
      cwd: intent.repositoryRoot,
      timeoutMs: 60_000,
    });
  }

  private async applyEvidence(intent: WorkspaceForkIntent): Promise<void> {
    const stagedPatch = Buffer.from(intent.evidence.payload.stagedPatchBase64, 'base64');
    if (stagedPatch.byteLength > 0) {
      await this.runner.run({
        executable: 'git',
        args: ['apply', '--binary', '--index', '--whitespace=nowarn', '-'],
        cwd: intent.workspacePath,
        input: stagedPatch,
      });
    }
    const unstagedPatch = Buffer.from(intent.evidence.payload.unstagedPatchBase64, 'base64');
    if (unstagedPatch.byteLength > 0) {
      await this.runner.run({
        executable: 'git',
        args: ['apply', '--binary', '--whitespace=nowarn', '-'],
        cwd: intent.workspacePath,
        input: unstagedPatch,
      });
    }
    for (const file of intent.evidence.manifest.untrackedFiles) {
      await this.restoreUntrackedFile(intent, file);
    }
  }

  private async restoreUntrackedFile(
    intent: WorkspaceForkIntent,
    file: AnchorUntrackedFile,
  ): Promise<void> {
    const target = this.resolveWithinWorkspace(intent.workspacePath, file.path);
    const blob = Buffer.from(intent.evidence.payload.untrackedBlobs[file.sha256], 'base64');
    await this.ensureSafeParent(intent.workspacePath, target);
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      file.mode,
    );
    try {
      await handle.writeFile(blob);
      await handle.chmod(file.mode);
      await handle.sync();
      const writtenStat = await handle.stat();
      if (
        !writtenStat.isFile()
        || writtenStat.isSymbolicLink()
        || writtenStat.size !== file.sizeBytes
      ) {
        throw new IsolatedWorkspaceError(
          'WORKSPACE_PREPARATION_FAILED',
          `untracked file was not written atomically: ${file.path}`,
        );
      }
    } finally {
      await handle.close();
    }
    const [canonicalWorkspacePath, canonicalTarget] = await Promise.all([
      realpath(intent.workspacePath),
      realpath(target),
    ]);
    const relative = path.relative(canonicalWorkspacePath, canonicalTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_PREPARATION_FAILED',
        `untracked file resolved outside isolated workspace: ${file.path}`,
      );
    }
  }

  private async verifyWorkspace(intent: WorkspaceForkIntent): Promise<void> {
    const head = (await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--verify', 'HEAD'],
      cwd: intent.workspacePath,
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
        cwd: intent.workspacePath,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--'],
        cwd: intent.workspacePath,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        cwd: intent.workspacePath,
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
      const target = this.resolveWithinWorkspace(intent.workspacePath, expected.path);
      const [bytes, fileStat] = await Promise.all([readFile(target), lstat(target)]);
      if (
        !fileStat.isFile()
        || fileStat.isSymbolicLink()
        || bytes.byteLength !== expected.sizeBytes
        || sha256(bytes) !== expected.sha256
        || (fileStat.mode & 0o777) !== expected.mode
      ) {
        throw new IsolatedWorkspaceError(
          'WORKSPACE_VERIFICATION_FAILED',
          `isolated untracked file differs from evidence: ${expected.path}`,
        );
      }
    }
  }

  private async cleanupWorkspace(intent: WorkspaceForkIntent): Promise<void> {
    this.assertWithinDurableRoot(intent.workspacePath);
    if (!await this.pathExists(intent.workspacePath)) return;

    const worktreeList = (await this.runner.run({
      executable: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: intent.repositoryRoot,
    })).stdout.toString('utf8');
    const registeredPaths = worktreeList
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    const [canonicalWorkspacePath, canonicalRegisteredPaths] = await Promise.all([
      realpath(intent.workspacePath),
      Promise.all(registeredPaths.map(async (registeredPath) => {
        return await realpath(registeredPath).catch(() => path.resolve(registeredPath));
      })),
    ]);
    const canonicalDurableRoot = await realpath(this.durableRoot);
    const durableRelative = path.relative(canonicalDurableRoot, canonicalWorkspacePath);
    if (
      !durableRelative
      || durableRelative === '..'
      || durableRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(durableRelative)
    ) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_CLEANUP_FAILED',
        'refusing to clean a workspace that resolves outside durableRoot',
      );
    }
    if (!canonicalRegisteredPaths.includes(canonicalWorkspacePath)) {
      throw new IsolatedWorkspaceError(
        'WORKSPACE_CLEANUP_FAILED',
        'refusing to delete an unregistered workspace path',
      );
    }
    await this.runner.run({
      executable: 'git',
      args: ['worktree', 'remove', '--force', intent.workspacePath],
      cwd: intent.repositoryRoot,
      timeoutMs: 60_000,
    });
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

  private async ensureSafeParent(workspacePath: string, target: string): Promise<void> {
    const parentRelative = path.relative(workspacePath, path.dirname(target));
    const parts = parentRelative ? parentRelative.split(path.sep) : [];
    let current = workspacePath;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const currentStat = await lstat(current);
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
          throw new IsolatedWorkspaceError(
            'WORKSPACE_PREPARATION_FAILED',
            'untracked file parent is not a safe directory',
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o700 });
      }
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
