// ============================================================================
// workspaceSnapshot 单测 — 验证工作区卫生（QA/验证不污染用户工作区）
// 验证命令跑前后对工作区做有界快照 diff，非空则在证据里标 workspaceSideEffects。
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
} from '../../../src/host/agent/workspaceSnapshot';

let dirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-snap-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('captureWorkspaceSnapshot / diffWorkspaceSnapshots', () => {
  it('无变更 → diff 为空', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'a.txt'), 'hello');
    const before = captureWorkspaceSnapshot(ws);
    const after = captureWorkspaceSnapshot(ws);
    expect(diffWorkspaceSnapshots(before, after)).toEqual([]);
  });

  it('新增/修改/删除各自可检出', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'keep.txt'), 'same');
    writeFileSync(join(ws, 'mod.txt'), 'v1');
    writeFileSync(join(ws, 'gone.txt'), 'bye');
    const before = captureWorkspaceSnapshot(ws);
    writeFileSync(join(ws, 'new.txt'), 'added');
    writeFileSync(join(ws, 'mod.txt'), 'v2-longer');
    rmSync(join(ws, 'gone.txt'));
    const after = captureWorkspaceSnapshot(ws);
    const diff = diffWorkspaceSnapshots(before, after);
    expect(diff).toContain('added: new.txt');
    expect(diff).toContain('modified: mod.txt');
    expect(diff).toContain('removed: gone.txt');
    expect(diff.some((d) => d.includes('keep.txt'))).toBe(false);
  });

  it('node_modules/.git 等重目录跳过，不进快照', () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'node_modules'), { recursive: true });
    writeFileSync(join(ws, 'node_modules', 'x.js'), 'x');
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, '.git', 'HEAD'), 'ref');
    const before = captureWorkspaceSnapshot(ws);
    writeFileSync(join(ws, 'node_modules', 'y.js'), 'y');
    const after = captureWorkspaceSnapshot(ws);
    expect(diffWorkspaceSnapshots(before, after)).toEqual([]);
  });

  it('超出 maxEntries → truncated=true（调用方应跳过 diff 防误报）', () => {
    const ws = makeWorkspace();
    for (let i = 0; i < 20; i++) writeFileSync(join(ws, `f${i}.txt`), String(i));
    const snap = captureWorkspaceSnapshot(ws, { maxEntries: 5 });
    expect(snap.truncated).toBe(true);
  });

  it('不存在的目录 → 空快照不抛错（fail-safe）', () => {
    const snap = captureWorkspaceSnapshot('/nonexistent/path/xyz');
    expect(snap.entries.size).toBe(0);
    expect(snap.truncated).toBe(false);
  });

  it('工作目录=家目录 → 拒绝下钻（TCC 护栏），标 truncated 跳过 diff', async () => {
    const { homedir } = await import('os');
    const snap = captureWorkspaceSnapshot(homedir());
    expect(snap.entries.size).toBe(0);
    expect(snap.truncated).toBe(true);
  });
});
