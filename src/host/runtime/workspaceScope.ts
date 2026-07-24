import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import type {
  ProjectSourceAccess,
  WorkspaceRoot,
  WorkspaceScope,
} from '../../shared/contract/project';

function filesystemCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

/** Canonicalize existing ancestors while preserving a not-yet-created suffix. */
export function canonicalizeWorkspacePath(input: string, depth = 0): string {
  const resolved = path.resolve(input);
  if (depth > 40) throw new Error(`Path exceeds symlink resolution limit: ${resolved}`);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;

  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(cursor, parts[index]);
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(next), readlinkSync(next));
        return canonicalizeWorkspacePath(path.resolve(target, ...parts.slice(index + 1)), depth + 1);
      }
      cursor = next;
    } catch (error) {
      const code = filesystemCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      try {
        return path.resolve(realpathSync.native(cursor), ...parts.slice(index));
      } catch (realpathError) {
        const realpathCode = filesystemCode(realpathError);
        if (realpathCode !== 'ENOENT' && realpathCode !== 'ENOTDIR') throw realpathError;
        return path.resolve(cursor, ...parts.slice(index));
      }
    }
  }
  return realpathSync.native(cursor);
}

export function workspacePathIdentity(input: string): { dev: string | null; ino: string | null } {
  try {
    const stat = statSync(canonicalizeWorkspacePath(input));
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return { dev: null, ino: null };
  }
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  try {
    const relative = path.relative(
      canonicalizeWorkspacePath(root),
      canonicalizeWorkspacePath(candidate),
    );
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function assertNonOverlappingRoots(roots: readonly Pick<WorkspaceRoot, 'sourceId' | 'path'>[]): void {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        isPathWithinRoot(roots[left].path, roots[right].path)
        || isPathWithinRoot(roots[right].path, roots[left].path)
      ) {
        throw new Error(`Project sources overlap: ${roots[left].path} and ${roots[right].path}`);
      }
    }
  }
}

export function createWorkspaceScope(projectId: string, inputRoots: readonly WorkspaceRoot[]): WorkspaceScope {
  const roots = inputRoots.map((root) => Object.freeze({
    ...root,
    path: canonicalizeWorkspacePath(root.path),
  }));
  const primary = roots.filter((root) => root.role === 'primary');
  if (primary.length !== 1) throw new Error('WorkspaceScope requires exactly one Primary source.');
  if (primary[0].access !== 'read_write') throw new Error('Primary source must be read_write.');
  if (new Set(roots.map((root) => root.path)).size !== roots.length) {
    throw new Error('WorkspaceScope contains duplicate canonical roots.');
  }
  assertNonOverlappingRoots(roots);
  const versionPayload = [...roots]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((root) => [
      root.sourceId,
      root.path,
      root.role,
      root.access,
      root.identityDev ?? '',
      root.identityIno ?? '',
    ].join('\u0000'))
    .join('\u0001');
  const version = createHash('sha256').update(versionPayload).digest('hex');
  return Object.freeze({
    projectId,
    primaryRoot: primary[0].path,
    roots: Object.freeze(roots),
    version,
  });
}

export interface WorkspacePathMatch {
  root: WorkspaceRoot;
  canonicalPath: string;
  relativePath: string;
}

export function resolveWorkspacePath(
  scope: WorkspaceScope,
  candidate: string,
  requiredAccess: ProjectSourceAccess | 'read' = 'read',
): WorkspacePathMatch | undefined {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizeWorkspacePath(candidate);
  } catch {
    // Malformed or excessively deep symlink chains are outside the trusted scope.
    return undefined;
  }
  const root = scope.roots.find((entry) => isPathWithinRoot(canonicalPath, entry.path));
  if (!root) return undefined;
  if (requiredAccess === 'read_write' && root.access !== 'read_write') return undefined;
  return {
    root,
    canonicalPath,
    relativePath: path.relative(root.path, canonicalPath),
  };
}

export class WorkspaceScopeResolver {
  constructor(readonly scope: WorkspaceScope) {}

  resolve(candidate: string): WorkspacePathMatch | undefined {
    return resolveWorkspacePath(this.scope, candidate, 'read');
  }

  canRead(candidate: string): boolean {
    return Boolean(this.resolve(candidate));
  }

  canWrite(candidate: string): boolean {
    return Boolean(resolveWorkspacePath(this.scope, candidate, 'read_write'));
  }

  assertRead(candidate: string): WorkspacePathMatch {
    const match = this.resolve(candidate);
    if (!match) throw new Error(`Path is outside Project Sources: ${candidate}`);
    return match;
  }

  assertWrite(candidate: string): WorkspacePathMatch {
    const match = resolveWorkspacePath(this.scope, candidate, 'read_write');
    if (!match) throw new Error(`Path is not writable in Project Sources: ${candidate}`);
    return match;
  }
}
