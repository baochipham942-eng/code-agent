import os from 'node:os';
import path from 'node:path';
import type { WorkspaceScope } from '../../shared/contract/project';
import { getHomeDir, getUserConfigDir } from '../config/configPaths';
import {
  canonicalizeWorkspacePath,
  createWorkspaceScope,
  isPathWithinRoot,
} from '../runtime/workspaceScope';

interface BackgroundWorkspaceInput {
  workspace?: string;
  workspaceScope?: WorkspaceScope;
}

interface BackgroundWorkspaceDirectories {
  homeDirectories?: readonly string[];
  dataDirectory?: string;
}

function canonicalizeOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return canonicalizeWorkspacePath(trimmed);
  } catch {
    return undefined;
  }
}

function isCodeAgentDataPath(candidate: string, homeDirectory: string): boolean {
  const relative = path.relative(homeDirectory, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0]?.startsWith('.code-agent') === true;
}

/**
 * Resolve the foreground run's already-frozen Project Source scope for delegation.
 * A synthetic legacy scope is allowed for an explicit safe project cwd, but home and
 * product-data fallbacks can never become an unattended write boundary.
 */
export function resolveBackgroundWorkspaceAuthority(
  input: BackgroundWorkspaceInput,
  directories: BackgroundWorkspaceDirectories = {},
): WorkspaceScope | undefined {
  const workspace = canonicalizeOrUndefined(input.workspace);
  const scopeRoot = canonicalizeOrUndefined(input.workspaceScope?.primaryRoot);
  if (workspace && scopeRoot && workspace !== scopeRoot) return undefined;
  const root = scopeRoot ?? workspace;
  if (!root) return undefined;

  const homeDirectories = directories.homeDirectories ?? [getHomeDir(), os.homedir()];
  const canonicalHomes = Array.from(new Set(homeDirectories
    .map((home) => canonicalizeOrUndefined(home))
    .filter((home): home is string => Boolean(home))));
  if (canonicalHomes.some((home) => root === home || isCodeAgentDataPath(root, home))) {
    return undefined;
  }

  const dataDirectory = canonicalizeOrUndefined(directories.dataDirectory ?? getUserConfigDir());
  if (dataDirectory && isPathWithinRoot(root, dataDirectory)) return undefined;

  // 只查「root 在敏感目录**里面**」是不够的，还要查「root **包含**敏感目录」：
  // $HOME 本身被上面挡住了，但 $HOME 的父目录（/Users）或文件系统根（/）不在任何拒绝项里，
  // 一旦被当成 workspace，$HOME/.code-agent 又变回「项目目录内」，W1 照样自动放行——
  // 拒绝清单被祖先路径整个绕过。对抗审查实测：/Users 与 / 都曾被 ACCEPTED。
  const sensitiveRoots = [...canonicalHomes, ...(dataDirectory ? [dataDirectory] : [])];
  if (sensitiveRoots.some((sensitive) => isPathWithinRoot(sensitive, root))) return undefined;

  if (input.workspaceScope) return input.workspaceScope;
  return createWorkspaceScope('legacy-background-authority', [{
    sourceId: 'legacy-background-primary',
    path: root,
    role: 'primary',
    access: 'read_write',
  }]);
}

/** Host-frozen foreground authority wins over any session state read by the child later. */
export function selectBackgroundWorkspaceScope(
  authoritativeScope: WorkspaceScope | undefined,
  sessionScope: WorkspaceScope | undefined,
): WorkspaceScope | undefined {
  return authoritativeScope ?? sessionScope;
}
