// ============================================================================
// ADR-073 K3 shared conflict oracle：同一张表同时驱动静态分段（classifyToolCalls）
// 与运行时写锁（getWriteIsolationScope + WriteIsolationManager）。每一行在两侧
// 必须得到同一个冲突答案——静态调度不得悄悄和运行时锁 disagree。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ToolConflictSide {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly permissionLevel: string | null;
}

export interface ToolResourceConflictCase {
  readonly note: string;
  readonly left: ToolConflictSide;
  readonly right: ToolConflictSide;
  /** 静态分段与运行时锁必须一致给出的冲突答案。 */
  readonly conflict: boolean;
  /** false = 至少一侧运行时无锁（两读、Task、Read 侧），运行时只断言该侧 scope 为 null。 */
  readonly runtimeLock: boolean;
}

export interface ConflictFixtureWorkspace {
  /** 主 workspace（realpath 过，含 dir/、real.txt、指向 real.txt 的 link.txt）。 */
  readonly root: string;
  /** 第二个无关 workspace 根（"同名相对路径不同根" 行用）。 */
  readonly other: string;
}

/** 建两个真实临时根：canonical 解析与 symlink 行需要真实文件系统状态。 */
export function createConflictFixtureWorkspace(): ConflictFixtureWorkspace {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolres-k3-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolres-k3-other-')));
  fs.mkdirSync(path.join(root, 'dir'));
  fs.writeFileSync(path.join(root, 'real.txt'), 'fixture');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
  return { root, other };
}

export function destroyConflictFixtureWorkspace(ws: ConflictFixtureWorkspace): void {
  fs.rmSync(ws.root, { recursive: true, force: true });
  fs.rmSync(ws.other, { recursive: true, force: true });
}

/**
 * ≥12 对（工具名, 参数, 权限级）。相对路径一律相对 ws.root（两侧 workspace=cwd=ws.root）；
 * 绝对路径行直接内嵌 ws 根。静态侧 permissionLevel 不参与解析，运行时侧靠它派生锁。
 */
export function toolResourceConflictCases(ws: ConflictFixtureWorkspace): ToolResourceConflictCase[] {
  const write = (file_path?: string): ToolConflictSide => ({
    toolName: 'Write',
    params: file_path === undefined ? {} : { file_path, content: 'x' },
    permissionLevel: 'write',
  });
  const read = (file_path: string): ToolConflictSide => ({
    toolName: 'Read',
    params: { file_path },
    permissionLevel: 'read',
  });
  return [
    {
      note: 'same file',
      left: write('a.txt'), right: write('a.txt'),
      conflict: true, runtimeLock: true,
    },
    {
      note: 'parent dir vs child file',
      left: write('dir'), right: write(path.join('dir', 'child.txt')),
      conflict: true, runtimeLock: true,
    },
    {
      note: 'sibling files',
      left: write('a.txt'), right: write('b.txt'),
      conflict: false, runtimeLock: true,
    },
    {
      note: 'Bash vs any file write',
      left: { toolName: 'Bash', params: { command: 'npm test' }, permissionLevel: 'execute' },
      right: write('a.txt'),
      conflict: true, runtimeLock: true,
    },
    {
      note: 'Write vs Read same path',
      left: write('a.txt'), right: read('a.txt'),
      conflict: true, runtimeLock: false,
    },
    {
      note: 'read/read same path',
      left: read('a.txt'), right: read('a.txt'),
      conflict: false, runtimeLock: false,
    },
    {
      note: 'same relative path under two different workspace roots',
      left: write(path.join(ws.other, 'a.txt')), right: write('a.txt'),
      conflict: false, runtimeLock: true,
    },
    {
      note: 'symlinked spelling of the same file',
      left: write('link.txt'), right: write('real.txt'),
      conflict: true, runtimeLock: true,
    },
    {
      note: 'undeclared MCP vs Read',
      left: { toolName: 'mcp__x__delete', params: {}, permissionLevel: 'write' },
      right: read('a.txt'),
      conflict: true, runtimeLock: false,
    },
    {
      note: 'undeclared MCP vs file write',
      left: { toolName: 'mcp__x__delete', params: {}, permissionLevel: 'write' },
      right: write('a.txt'),
      conflict: true, runtimeLock: true,
    },
    {
      note: 'missing path argument on a write falls to the workspace lock',
      left: write(), right: write('b.txt'),
      conflict: true, runtimeLock: true,
    },
    {
      note: 'Task delegation vs Read',
      left: { toolName: 'Task', params: { prompt: 'x', subagent_type: 'coder' }, permissionLevel: 'execute' },
      right: read('a.txt'),
      conflict: true, runtimeLock: false,
    },
    {
      note: 'Task fan-out stays conflict-free',
      left: { toolName: 'Task', params: { prompt: 'x', subagent_type: 'coder' }, permissionLevel: 'execute' },
      right: { toolName: 'Task', params: { prompt: 'y', subagent_type: 'reviewer' }, permissionLevel: 'execute' },
      conflict: false, runtimeLock: false,
    },
    {
      note: 'absolute vs relative spelling of the same file',
      left: write(path.join(ws.root, 'a.txt')), right: write('a.txt'),
      conflict: true, runtimeLock: true,
    },
  ];
}
