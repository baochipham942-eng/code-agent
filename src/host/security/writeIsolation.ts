import path from 'path';
import { resolveCanonicalRunPath } from '../runtime/runContext';

export type WriteIsolationKind = 'file' | 'workspace';

export interface WriteIsolationScope {
  kind: WriteIsolationKind;
  root: string;
  targetPath: string;
  lockKey: string;
  toolName: string;
}

export interface WriteIsolationMetadata {
  kind: WriteIsolationKind;
  targetPath: string;
  lockKey: string;
  waitMs: number;
}

type ReleaseWriteIsolationLock = () => void;

interface Waiter {
  scope: WriteIsolationScope;
  resolve: (release: ReleaseWriteIsolationLock) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const FILE_PATH_PARAM_KEYS = [
  'file_path',
  'path',
  'target_path',
  'targetPath',
  'output_path',
  'outputPath',
];

const FILE_WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'append',
  'append_file',
  'multiedit',
  'multi_edit',
  'create_file',
  'replace_file',
]);

const DELEGATION_TOOLS = new Set([
  'task',
  'spawn_agent',
  'agentspawn',
]);

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function isDelegationTool(toolName: string): boolean {
  return DELEGATION_TOOLS.has(normalizedToolName(toolName));
}

function isExecuteTool(toolName: string, permissionLevel?: string): boolean {
  const normalized = normalizedToolName(toolName);
  return permissionLevel === 'execute'
    || normalized === 'bash'
    || normalized === 'shell'
    || normalized === 'execute_command';
}

function isFileWriteTool(toolName: string, permissionLevel?: string): boolean {
  return permissionLevel === 'write' || FILE_WRITE_TOOLS.has(normalizedToolName(toolName));
}

function firstStringParam(params: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function normalizeTargetPath(workingDirectory: string, candidate: string): string {
  const resolved = path.normalize(path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workingDirectory, candidate));
  return resolveCanonicalRunPath(resolved);
}

function isSameOrChild(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function scopeConflicts(left: WriteIsolationScope, right: WriteIsolationScope): boolean {
  if (left.root !== right.root) return false;
  if (left.kind === 'workspace' || right.kind === 'workspace') return true;
  return isSameOrChild(left.targetPath, right.targetPath)
    || isSameOrChild(right.targetPath, left.targetPath);
}

export function getWriteIsolationScope(
  toolName: string,
  params: Record<string, unknown>,
  workspace: string,
  permissionLevel?: string,
  cwd: string = workspace,
): WriteIsolationScope | null {
  const root = normalizeTargetPath(workspace, '.');

  // Delegation itself does not mutate the workspace. Child agents still acquire
  // write isolation for their own file writes and command execution.
  if (isDelegationTool(toolName)) {
    return null;
  }

  if (isExecuteTool(toolName, permissionLevel)) {
    return {
      kind: 'workspace',
      root,
      targetPath: root,
      lockKey: `workspace:${root}`,
      toolName,
    };
  }

  if (!isFileWriteTool(toolName, permissionLevel)) {
    return null;
  }

  const filePath = firstStringParam(params, FILE_PATH_PARAM_KEYS);
  if (!filePath) {
    return {
      kind: 'workspace',
      root,
      targetPath: root,
      lockKey: `workspace:${root}`,
      toolName,
    };
  }

  const targetPath = normalizeTargetPath(cwd, filePath);
  return {
    kind: 'file',
    root,
    targetPath,
    lockKey: `file:${targetPath}`,
    toolName,
  };
}

export class WriteIsolationManager {
  private active: WriteIsolationScope[] = [];
  private waiters: Waiter[] = [];

  acquire(scope: WriteIsolationScope, signal?: AbortSignal): Promise<ReleaseWriteIsolationLock> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Write isolation lock acquisition cancelled'));
    }

    if (!this.hasConflict(scope)) {
      return Promise.resolve(this.activate(scope));
    }

    return new Promise<ReleaseWriteIsolationLock>((resolve, reject) => {
      const waiter: Waiter = { scope, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error('Write isolation lock acquisition cancelled'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  reset(): void {
    this.active = [];
    for (const waiter of this.waiters) {
      this.detachAbort(waiter);
      waiter.reject(new Error('Write isolation manager reset'));
    }
    this.waiters = [];
  }

  private hasConflict(scope: WriteIsolationScope): boolean {
    return this.active.some((candidate) => scopeConflicts(scope, candidate));
  }

  private activate(scope: WriteIsolationScope): ReleaseWriteIsolationLock {
    let released = false;
    this.active.push(scope);
    return () => {
      if (released) return;
      released = true;
      this.active = this.active.filter((candidate) => candidate !== scope);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (this.hasConflict(waiter.scope)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      this.detachAbort(waiter);
      waiter.resolve(this.activate(waiter.scope));
    }
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}

const globalWriteIsolationManager = new WriteIsolationManager();

export function getWriteIsolationManager(): WriteIsolationManager {
  return globalWriteIsolationManager;
}

export function resetWriteIsolationForTests(): void {
  globalWriteIsolationManager.reset();
}
