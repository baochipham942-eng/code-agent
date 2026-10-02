import path from 'node:path';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { expandTilde } from '../tools/utils/resolveInputPath';
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

const UNKNOWN_READWRITE: ResolvedToolAccess = { kind: 'readwrite', domain: { type: 'unknown' } };

/**
 * 与写隔离原先的路径归一同一实现：相对 cwd 解析，再走运行时真实路径。
 * ~ 前缀先按工具的 resolveInputPath 同一份 expandTilde 展开——Read/Write/Append/Glob
 * 打开文件前都会展开，调度与写锁若不展开，同一文件的 ~/ 与绝对写法会拿到不同 key。
 */
export function normalizeTargetPath(workingDirectory: string, candidate: string): string {
  const expanded = expandTilde(candidate);
  const resolved = path.normalize(path.isAbsolute(expanded)
    ? expanded
    : path.resolve(workingDirectory, expanded));
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

function isAgentRuntime(access: ResolvedToolAccess): boolean {
  return access.domain.type === 'named' && access.domain.name === 'agent:runtime';
}

/**
 * 读/读不冲突。未知域与任意其他访问冲突（含另一个未知域和具体路径上的读），
 * 这样缺声明不会跟后续 Read 并进同一段。
 * agent:runtime 与自己不冲突（Task 扇出仍可同段）；与路径、workspace、其他命名域冲突，
 * 包括读/读。与 unscoped 不在这里强制，落到下面的原规则。
 * 命名域只在名字相同时冲突。路径与 workspace 的包含关系只此一份，写隔离锁走同一个函数。
 */
export function toolResourceAccessesConflict(
  left: ResolvedToolAccess,
  right: ResolvedToolAccess,
): boolean {
  if (left.domain.type === 'unknown' || right.domain.type === 'unknown') {
    return true;
  }
  const leftAgent = isAgentRuntime(left);
  const rightAgent = isAgentRuntime(right);
  if (leftAgent || rightAgent) {
    if (leftAgent && rightAgent) return false;
    const otherType = leftAgent ? right.domain.type : left.domain.type;
    if (otherType === 'path' || otherType === 'workspace' || otherType === 'named') return true;
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

/** 未定域读（readOnly 且无 accesses 声明）不知道自己会读到什么。 */
function isUnscopedRead(access: ResolvedToolAccess): boolean {
  return access.kind === 'read' && access.domain.type === 'unscoped';
}

/**
 * 段调度用的成对判定：在 toolResourceAccessesConflict 之上再收紧一条——
 * 未定域读与任何写（含命名域写、agent:runtime 写）都视为冲突。
 * fail closed：缺声明的只读工具（task_list/plan_read/MemoryRead 等）读到的东西
 * 一律当成可能被同批的写改动，宁可拆段也不并发。读写原语语义不变。
 */
export function segmentAccessesConflict(
  left: readonly ResolvedToolAccess[],
  right: readonly ResolvedToolAccess[],
): boolean {
  const leftAccesses = left.length > 0 ? left : [UNKNOWN_READWRITE];
  const rightAccesses = right.length > 0 ? right : [UNKNOWN_READWRITE];
  return leftAccesses.some((access) => rightAccesses.some((other) => {
    if (toolResourceAccessesConflict(access, other)) return true;
    if (isUnscopedRead(access)) return other.kind !== 'read';
    if (isUnscopedRead(other)) return access.kind !== 'read';
    return false;
  }));
}
