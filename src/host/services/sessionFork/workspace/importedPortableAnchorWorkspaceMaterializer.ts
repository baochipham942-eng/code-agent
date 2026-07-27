import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { PortableIsolatedAnchorEvidenceV1 } from '../../../../shared/contract/sessionForkPortability';
import {
  validatePortableIsolatedAnchorEvidenceV1,
} from '../portability/portableWorkspaceEvidence';
import {
  AnchorWorkspaceEvidenceService,
  digestWorkspaceValue,
} from './anchorEvidence';
import { NodeWorkspaceCommandRunner } from './commandRunner';
import type { IsolatedAnchorWorkspaceService } from './isolatedAnchorWorkspaceService';
import type {
  AnchorPathMapping,
  AnchorWorkspaceEvidence,
  PreparedIsolatedAnchorWorkspace,
  WorkspaceCommandRunner,
} from './types';

type ImportedPortableAnchorWorkspaceErrorCode =
  | 'TARGET_WORKSPACE_BINDING_REQUIRED'
  | 'BASE_COMMIT_UNAVAILABLE'
  | 'PORTABLE_EVIDENCE_INVALID'
  | 'MATERIALIZED_WORKSPACE_INVALID';

class ImportedPortableAnchorWorkspaceError extends Error {
  constructor(
    readonly code: ImportedPortableAnchorWorkspaceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ImportedPortableAnchorWorkspaceError';
  }
}

export interface TrustedSingleRootGitProjectWorkspace {
  projectId: string;
  topology: 'single_root_git';
  identityTrust: 'verified';
  repositoryRoot: string;
  workspaceScopeVersion: string;
}

export interface MaterializeImportedPortableAnchorWorkspaceInput {
  portableEvidence: PortableIsolatedAnchorEvidenceV1;
  targetProjectId: string;
  workspaceBinding: TrustedSingleRootGitProjectWorkspace;
  intentId: string;
  sourceSessionId: string;
  proposedChildSessionId: string;
  destinationName: string;
}

export interface ReboundImportedPortableAnchorWorkspaceEvidence {
  repositoryRoot: string;
  evidence: AnchorWorkspaceEvidence;
}

interface ImportedPortableAnchorWorkspaceMaterializerOptions {
  workspaceService: Pick<IsolatedAnchorWorkspaceService, 'prepare'>;
  evidenceService?: AnchorWorkspaceEvidenceService;
  runner?: WorkspaceCommandRunner;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeBlob(
  evidence: PortableIsolatedAnchorEvidenceV1,
  digest: string,
): Buffer {
  return Buffer.from(evidence.content.blobs[digest], 'base64');
}

function rawDigest(value: string): string {
  return value.replace(/^sha256:/u, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ImportedPortableAnchorWorkspaceMaterializer {
  private readonly workspaceService: Pick<IsolatedAnchorWorkspaceService, 'prepare'>;
  private readonly evidenceService: AnchorWorkspaceEvidenceService;
  private readonly runner: WorkspaceCommandRunner;

  constructor(options: ImportedPortableAnchorWorkspaceMaterializerOptions) {
    this.workspaceService = options.workspaceService;
    this.runner = options.runner ?? new NodeWorkspaceCommandRunner();
    this.evidenceService = options.evidenceService ?? new AnchorWorkspaceEvidenceService({
      runner: this.runner,
    });
  }

  async materialize(
    input: MaterializeImportedPortableAnchorWorkspaceInput,
  ): Promise<PreparedIsolatedAnchorWorkspace> {
    const rebound = await this.rebindEvidence(input);
    const prepared = await this.workspaceService.prepare({
      intentId: input.intentId,
      sourceSessionId: input.sourceSessionId,
      proposedChildSessionId: input.proposedChildSessionId,
      repositoryRoot: rebound.repositoryRoot,
      destinationName: input.destinationName,
      evidence: rebound.evidence,
    });
    await this.verifyPreparedWorkspace(prepared, input.portableEvidence, rebound.evidence);
    return prepared;
  }

  async rebindEvidence(
    input: MaterializeImportedPortableAnchorWorkspaceInput,
  ): Promise<ReboundImportedPortableAnchorWorkspaceEvidence> {
    this.requireTrustedBinding(input);
    validatePortableIsolatedAnchorEvidenceV1(input.portableEvidence);
    const repositoryIdentity = await this.evidenceService.computeRepositoryIdentity(
      input.workspaceBinding.repositoryRoot,
    ).catch((error: unknown) => {
      throw new ImportedPortableAnchorWorkspaceError(
        'TARGET_WORKSPACE_BINDING_REQUIRED',
        `target repository identity cannot be verified: ${errorMessage(error)}`,
        error,
      );
    });
    await this.requireBaseCommit(
      repositoryIdentity.canonicalRoot,
      input.portableEvidence.baseCommit,
    );
    const evidence = await this.rebuildLocalEvidence(
      input.portableEvidence,
      repositoryIdentity,
      input.workspaceBinding.workspaceScopeVersion,
    );
    await this.evidenceService.validateBundle(evidence).catch((error: unknown) => {
      throw new ImportedPortableAnchorWorkspaceError(
        'PORTABLE_EVIDENCE_INVALID',
        errorMessage(error),
        error,
      );
    });
    await this.evidenceService.assertRepositoryIdentity(
      evidence,
      repositoryIdentity.canonicalRoot,
    ).catch((error: unknown) => {
      throw new ImportedPortableAnchorWorkspaceError(
        'TARGET_WORKSPACE_BINDING_REQUIRED',
        errorMessage(error),
        error,
      );
    });

    return {
      repositoryRoot: repositoryIdentity.canonicalRoot,
      evidence,
    };
  }

  private requireTrustedBinding(input: MaterializeImportedPortableAnchorWorkspaceInput): void {
    const binding = input.workspaceBinding;
    if (
      !input.targetProjectId.trim()
      || !binding.projectId.trim()
      || binding.projectId !== input.targetProjectId
      || binding.topology !== 'single_root_git'
      || binding.identityTrust !== 'verified'
      || !path.isAbsolute(binding.repositoryRoot)
      || !binding.workspaceScopeVersion.trim()
    ) {
      throw new ImportedPortableAnchorWorkspaceError(
        'TARGET_WORKSPACE_BINDING_REQUIRED',
        'an exact trusted single-root Git Project workspace binding is required',
      );
    }
  }

  private async requireBaseCommit(repositoryRoot: string, baseCommit: string): Promise<void> {
    const resolved = await this.runner.run({
      executable: 'git',
      args: ['rev-parse', '--verify', `${baseCommit}^{commit}`],
      cwd: repositoryRoot,
    }).then((result) => result.stdout.toString('utf8').trim()).catch((error: unknown) => {
      throw new ImportedPortableAnchorWorkspaceError(
        'BASE_COMMIT_UNAVAILABLE',
        `portable base commit does not exist in the target repository: ${errorMessage(error)}`,
        error,
      );
    });
    if (resolved !== baseCommit) {
      throw new ImportedPortableAnchorWorkspaceError(
        'BASE_COMMIT_UNAVAILABLE',
        'target repository resolved a different base commit',
      );
    }
  }

  private async rebuildLocalEvidence(
    portable: PortableIsolatedAnchorEvidenceV1,
    repositoryIdentity: AnchorWorkspaceEvidence['manifest']['repositoryIdentity'],
    workspaceScopeVersion: string,
  ): Promise<AnchorWorkspaceEvidence> {
    const pathMappings = await Promise.all(portable.pathMappings.map(async (mapping, index) => {
      const sourcePath = mapping.relativePath === '.'
        ? repositoryIdentity.canonicalRoot
        : path.resolve(
          repositoryIdentity.canonicalRoot,
          ...mapping.relativePath.split('/'),
        );
      const canonicalSourcePath = await realpath(sourcePath).catch((error: unknown) => {
        throw new ImportedPortableAnchorWorkspaceError(
          'TARGET_WORKSPACE_BINDING_REQUIRED',
          `target path mapping ${mapping.relativePath} cannot be resolved: ${errorMessage(error)}`,
          error,
        );
      });
      const relative = path.relative(repositoryIdentity.canonicalRoot, canonicalSourcePath);
      if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new ImportedPortableAnchorWorkspaceError(
          'TARGET_WORKSPACE_BINDING_REQUIRED',
          `target path mapping ${mapping.relativePath} escapes the bound repository`,
        );
      }
      return {
        sourceId: `portable-source-${index}`,
        sourcePath: canonicalSourcePath,
        repositoryRelativePath: mapping.relativePath,
        isolatedRelativePath: mapping.isolatedRelativePath,
      } satisfies AnchorPathMapping;
    }));
    const stagedPatch = decodeBlob(portable, portable.content.stagedPatch.blobDigest);
    const unstagedPatch = decodeBlob(portable, portable.content.unstagedPatch.blobDigest);
    const untrackedBlobs: Record<string, string> = {};
    for (const file of portable.content.untrackedFiles) {
      untrackedBlobs[rawDigest(file.blobDigest)] = portable.content.blobs[file.blobDigest];
    }
    const manifestWithoutDigest = {
      version: 1 as const,
      captureState: 'complete' as const,
      anchorId: portable.evidenceId,
      capturedAt: portable.capturedAt,
      baseCommit: portable.baseCommit,
      baseCommitSource: 'explicit_anchor_input' as const,
      observedHead: portable.observedHead,
      workspaceScopeVersion,
      repositoryIdentity,
      pathMappings,
      stagedPatch: {
        sha256: rawDigest(portable.content.stagedPatch.blobDigest),
        sizeBytes: stagedPatch.byteLength,
      },
      unstagedPatch: {
        sha256: rawDigest(portable.content.unstagedPatch.blobDigest),
        sizeBytes: unstagedPatch.byteLength,
      },
      untrackedFiles: portable.content.untrackedFiles.map((file) => ({
        path: file.relativePath,
        sha256: rawDigest(file.blobDigest),
        sizeBytes: file.sizeBytes,
        mode: file.mode,
      })),
    };
    const payload = {
      stagedPatchBase64: stagedPatch.toString('base64'),
      unstagedPatchBase64: unstagedPatch.toString('base64'),
      untrackedBlobs,
    };
    return {
      manifest: {
        ...manifestWithoutDigest,
        evidenceDigest: digestWorkspaceValue({
          manifest: manifestWithoutDigest,
          payload,
        }),
      },
      payload,
    };
  }

  private async verifyPreparedWorkspace(
    prepared: PreparedIsolatedAnchorWorkspace,
    portable: PortableIsolatedAnchorEvidenceV1,
    evidence: AnchorWorkspaceEvidence,
  ): Promise<void> {
    if (
      prepared.status !== 'ready'
      || !prepared.advertisable
      || prepared.baseCommit !== portable.baseCommit
      || prepared.evidenceDigest !== evidence.manifest.evidenceDigest
      || prepared.workspaceScopeVersion !== evidence.manifest.workspaceScopeVersion
    ) {
      throw new ImportedPortableAnchorWorkspaceError(
        'MATERIALIZED_WORKSPACE_INVALID',
        'isolated workspace service did not return a sealed ready workspace',
      );
    }
    const expectedMappings = evidence.manifest.pathMappings.map((mapping) => ({
      repositoryRelativePath: mapping.repositoryRelativePath,
      isolatedRelativePath: mapping.isolatedRelativePath,
      isolatedPath: path.resolve(
        prepared.workspacePath,
        ...mapping.isolatedRelativePath.split('/').filter((part) => part !== '.'),
      ),
    }));
    const actualMappings = prepared.pathMappings.map((mapping) => ({
      repositoryRelativePath: mapping.repositoryRelativePath,
      isolatedRelativePath: mapping.isolatedRelativePath,
      isolatedPath: mapping.isolatedPath,
    }));
    if (JSON.stringify(actualMappings) !== JSON.stringify(expectedMappings)) {
      throw new ImportedPortableAnchorWorkspaceError(
        'MATERIALIZED_WORKSPACE_INVALID',
        'materialized path mappings differ from portable evidence',
      );
    }
    const [head, staged, unstaged, untracked] = await Promise.all([
      this.runner.run({
        executable: 'git',
        args: ['rev-parse', '--verify', 'HEAD'],
        cwd: prepared.workspacePath,
      }).then((result) => result.stdout.toString('utf8').trim()),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--cached', portable.baseCommit, '--'],
        cwd: prepared.workspacePath,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['diff', '--binary', '--full-index', '--'],
        cwd: prepared.workspacePath,
      }).then((result) => result.stdout),
      this.runner.run({
        executable: 'git',
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        cwd: prepared.workspacePath,
      }).then((result) => result.stdout),
    ]).catch((error: unknown) => {
      throw new ImportedPortableAnchorWorkspaceError(
        'MATERIALIZED_WORKSPACE_INVALID',
        errorMessage(error),
        error,
      );
    });
    if (
      head !== portable.baseCommit
      || staged.byteLength !== portable.content.stagedPatch.sizeBytes
      || sha256(staged) !== portable.content.stagedPatch.blobDigest
      || unstaged.byteLength !== portable.content.unstagedPatch.sizeBytes
      || sha256(unstaged) !== portable.content.unstagedPatch.blobDigest
    ) {
      throw new ImportedPortableAnchorWorkspaceError(
        'MATERIALIZED_WORKSPACE_INVALID',
        'materialized HEAD or tracked diff differs from portable evidence',
      );
    }
    const untrackedPaths = untracked.toString('utf8').split('\0').filter(Boolean).sort();
    const expectedUntrackedPaths = portable.content.untrackedFiles.map((file) => file.relativePath);
    if (JSON.stringify(untrackedPaths) !== JSON.stringify(expectedUntrackedPaths)) {
      throw new ImportedPortableAnchorWorkspaceError(
        'MATERIALIZED_WORKSPACE_INVALID',
        'materialized untracked manifest differs from portable evidence',
      );
    }
    for (const file of portable.content.untrackedFiles) {
      const target = path.resolve(prepared.workspacePath, ...file.relativePath.split('/'));
      const [bytes, targetStat, canonicalTarget] = await Promise.all([
        readFile(target),
        stat(target),
        realpath(target),
      ]);
      const relative = path.relative(await realpath(prepared.workspacePath), canonicalTarget);
      if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || !targetStat.isFile()
        || bytes.byteLength !== file.sizeBytes
        || sha256(bytes) !== file.blobDigest
        || (targetStat.mode & 0o777) !== file.mode
      ) {
        throw new ImportedPortableAnchorWorkspaceError(
          'MATERIALIZED_WORKSPACE_INVALID',
          `materialized untracked file differs: ${file.relativePath}`,
        );
      }
    }
  }
}
