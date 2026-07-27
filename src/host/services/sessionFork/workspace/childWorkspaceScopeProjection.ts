import path from 'node:path';

import type { WorkspaceScope } from '../../../../shared/contract/project';

export interface ChildWorkspacePathMappingProvenance {
  sourceId: string;
  sourcePath: string;
  sourceRelativePath: string;
  isolatedRelativePath: string;
}

export interface ChildWorkspaceScopeVerification {
  forkId: string;
  intentId: string;
  evidenceId: string;
  projectId: string;
  sourceWorkspaceScopeVersion: string;
  sourcePrimaryRoot: string;
  isolatedPrimaryRoot: string;
  baseCommit: string;
  evidenceDigest: string;
}

export interface ChildWorkspaceScopeProjection {
  scope: WorkspaceScope;
  verification: ChildWorkspaceScopeVerification;
  provenance: {
    sourceIdentity: Record<string, unknown>;
    pathMappings: ChildWorkspacePathMappingProvenance[];
  };
}

export class ChildWorkspaceScopeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildWorkspaceScopeProjectionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ChildWorkspaceScopeProjectionError(`forkWorkspaceScopeV1.${key} is required`);
  }
  return value.trim();
}

function absolutePath(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new ChildWorkspaceScopeProjectionError(`forkWorkspaceScopeV1.${key} must be canonical absolute path`);
  }
  return value;
}

function safeRelativePath(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw new ChildWorkspaceScopeProjectionError(`${key} is not a safe relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    throw new ChildWorkspaceScopeProjectionError(`${key} escapes its workspace`);
  }
  return normalized;
}

export function projectChildWorkspaceScope(
  metadata: unknown,
): ChildWorkspaceScopeProjection | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata.forkWorkspaceScopeV1;
  if (raw === undefined) return null;
  if (!isRecord(raw) || raw.version !== 1) {
    throw new ChildWorkspaceScopeProjectionError('forkWorkspaceScopeV1 has an unsupported schema');
  }

  const verification: ChildWorkspaceScopeVerification = {
    forkId: requiredString(raw, 'forkId'),
    intentId: requiredString(raw, 'intentId'),
    evidenceId: requiredString(raw, 'evidenceId'),
    projectId: requiredString(raw, 'projectId'),
    sourceWorkspaceScopeVersion: requiredString(raw, 'sourceWorkspaceScopeVersion'),
    sourcePrimaryRoot: absolutePath(raw, 'sourcePrimaryRoot'),
    isolatedPrimaryRoot: absolutePath(raw, 'isolatedPrimaryRoot'),
    baseCommit: requiredString(raw, 'baseCommit'),
    evidenceDigest: requiredString(raw, 'evidenceDigest'),
  };
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(verification.baseCommit)) {
    throw new ChildWorkspaceScopeProjectionError('forkWorkspaceScopeV1.baseCommit is invalid');
  }
  if (!/^[0-9a-f]{64}$/iu.test(verification.evidenceDigest)) {
    throw new ChildWorkspaceScopeProjectionError('forkWorkspaceScopeV1.evidenceDigest is invalid');
  }
  if (!isRecord(raw.sourceIdentity)) {
    throw new ChildWorkspaceScopeProjectionError('forkWorkspaceScopeV1.sourceIdentity is required');
  }
  if (!Array.isArray(raw.pathMappings) || raw.pathMappings.length !== 1) {
    throw new ChildWorkspaceScopeProjectionError('isolated WorkspaceScope requires exactly one path mapping');
  }
  const sourceIds = new Set<string>();
  const pathMappings = raw.pathMappings.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new ChildWorkspaceScopeProjectionError(`pathMappings[${index}] is invalid`);
    }
    const sourceId = requiredString(candidate, 'sourceId');
    if (sourceIds.has(sourceId)) {
      throw new ChildWorkspaceScopeProjectionError('path mapping source ids must be unique');
    }
    sourceIds.add(sourceId);
    return {
      sourceId,
      sourcePath: absolutePath(candidate, 'sourcePath'),
      sourceRelativePath: safeRelativePath(
        candidate.sourceRelativePath,
        `pathMappings[${index}].sourceRelativePath`,
      ),
      isolatedRelativePath: safeRelativePath(
        candidate.isolatedRelativePath,
        `pathMappings[${index}].isolatedRelativePath`,
      ),
    };
  });
  if (
    pathMappings[0].sourcePath !== verification.sourcePrimaryRoot
    || pathMappings[0].sourceRelativePath !== '.'
    || pathMappings[0].isolatedRelativePath !== '.'
  ) {
    throw new ChildWorkspaceScopeProjectionError('the primary root path mapping is incomplete');
  }

  return {
    scope: {
      projectId: verification.projectId,
      primaryRoot: verification.isolatedPrimaryRoot,
      roots: [{
        sourceId: `isolated:${verification.intentId}`,
        path: verification.isolatedPrimaryRoot,
        access: 'read_only',
        role: 'primary',
      }],
      version: `isolated-v1:${verification.intentId}:${verification.evidenceDigest}`,
    },
    verification,
    provenance: {
      sourceIdentity: structuredClone(raw.sourceIdentity),
      pathMappings,
    },
  };
}
