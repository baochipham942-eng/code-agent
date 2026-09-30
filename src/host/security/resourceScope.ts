import path from 'node:path';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import type { ToolAccessKind } from '../protocol/tools';

export type ToolResourceDomain =
  | { readonly type: 'path'; readonly root: string; readonly targetPath: string }
  | { readonly type: 'workspace'; readonly root: string; readonly targetPath: string }
  | { readonly type: 'named'; readonly name: string }
  | { readonly type: 'unknown' }
  | { readonly type: 'unscoped' };

export interface ResolvedToolAccess {
  readonly kind: ToolAccessKind;
  readonly domain: ToolResourceDomain;
}

/** 与写隔离原先的路径归一同一实现：相对 cwd 解析，再走运行时真实路径。 */
export function normalizeTargetPath(workingDirectory: string, candidate: string): string {
  const resolved = path.normalize(path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workingDirectory, candidate));
  return resolveCanonicalRunPath(resolved);
}

function pathsAreSameOrChild(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function domainRoot(domain: ToolResourceDomain): string | null {
  if (domain.type === 'path' || domain.type === 'workspace') return domain.root;
  return null;
}

function domainTarget(domain: ToolResourceDomain): string | null {
  if (domain.type === 'path' || domain.type === 'workspace') return domain.targetPath;
  return null;
}

/**
 * 读/读不冲突。未知域与任意其他访问冲突（含另一个未知域和具体路径上的读），
 * 这样缺声明不会跟后续 Read 并进同一段。命名域只在名字相同时冲突。
 * 路径与 workspace 的包含关系只此一份，写隔离锁走同一个函数。
 */
export function toolResourceAccessesConflict(
  left: ResolvedToolAccess,
  right: ResolvedToolAccess,
): boolean {
  if (left.domain.type === 'unknown' || right.domain.type === 'unknown') {
    return true;
  }
  const leftWrites = left.kind !== 'read';
  const rightWrites = right.kind !== 'read';
  if (!leftWrites && !rightWrites) return false;

  if (left.domain.type === 'unscoped' || right.domain.type === 'unscoped') {
    return left.domain.type === 'unscoped' && right.domain.type === 'unscoped';
  }
  if (left.domain.type === 'named' || right.domain.type === 'named') {
    return left.domain.type === 'named'
      && right.domain.type === 'named'
      && left.domain.name === right.domain.name;
  }

  const leftRoot = domainRoot(left.domain);
  const rightRoot = domainRoot(right.domain);
  if (leftRoot === null || rightRoot === null || leftRoot !== rightRoot) return false;
  if (left.domain.type === 'workspace' || right.domain.type === 'workspace') return true;
  const leftTarget = domainTarget(left.domain);
  const rightTarget = domainTarget(right.domain);
  if (leftTarget === null || rightTarget === null) return false;
  return pathsAreSameOrChild(leftTarget, rightTarget)
    || pathsAreSameOrChild(rightTarget, leftTarget);
}
