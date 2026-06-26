// ============================================================================
// 功能 3：删除/清理链路的 patch 安全网（真实 git fixture + 真实 capture）
// getUserConfigDir mock 到临时目录，避免污染 ~/.code-agent。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cfgState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/host/config/configPaths', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/config/configPaths')>(
    '../../../src/host/config/configPaths'
  );
  return { ...actual, getUserConfigDir: () => cfgState.dir };
});

import {
  createAgentWorktree,
  cleanupAgentWorktree,
  cleanupOrphanedWorktrees,
} from '../../../src/host/agent/agentWorktree';
import { getTrashedPatchDir } from '../../../src/host/services/checkpoint/taskPatchService';

function git(repo: string, args: string): void {
  execSync(`git ${args}`, {
    cwd: repo,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-patch-repo-'));
  git(repo, 'init -q');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(repo, 'add file.txt');
  git(repo, 'commit -q -m init');
  return repo;
}

function listPatches(): string[] {
  const dir = getTrashedPatchDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe('worktree cleanup patch safety net (real git)', () => {
  let repo: string;
  const createdWorktrees: string[] = [];
  const tmpToClean: string[] = [];

  beforeEach(() => {
    cfgState.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-patch-cfg-'));
    tmpToClean.push(cfgState.dir);
    repo = makeRepo();
    tmpToClean.push(repo);
    createdWorktrees.length = 0;
  });

  afterEach(() => {
    for (const wt of createdWorktrees) {
      try {
        execSync(`git worktree remove --force '${wt}'`, { cwd: repo, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
    }
    while (tmpToClean.length) {
      const p = tmpToClean.pop()!;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('cleanupAgentWorktree：有改动时导出 patch 并保留 worktree 供合并', async () => {
    const agentId = `clean-${Date.now()}`;
    const info = await createAgentWorktree(agentId, repo);
    createdWorktrees.push(info.worktreePath);

    // 在 worktree 里做改动
    fs.writeFileSync(path.join(info.worktreePath, 'file.txt'), 'base\nagent edit\n');
    fs.writeFileSync(path.join(info.worktreePath, 'new.txt'), 'agent new file\n');

    const result = await cleanupAgentWorktree(agentId, info.worktreePath, repo);

    // 有改动 → 保留 worktree（供 parent merge）
    expect(result.hasChanges).toBe(true);
    expect(result.worktreePath).toBe(info.worktreePath);

    // 改动被导出成 patch（安全网）
    const patches = listPatches();
    expect(patches.length).toBe(1);
    const content = fs.readFileSync(path.join(getTrashedPatchDir(), patches[0]), 'utf-8');
    expect(content).toContain('agent edit');
    expect(content).toContain('new.txt');
    expect(content).toContain('# reason: worktree-cleanup');
  });

  it('cleanupOrphanedWorktrees：过期 worktree 有改动 → 导出 patch → worktree 被移除', async () => {
    const agentId = `orphan-${Date.now()}`;
    const info = await createAgentWorktree(agentId, repo);
    // 不 push 到 createdWorktrees——本用例验证它被 orphan cleanup 移除

    fs.writeFileSync(path.join(info.worktreePath, 'file.txt'), 'base\norphaned work\n');

    // 把 worktree mtime 设为很久以前，使其超过 maxAge
    const old = Date.now() - 3 * 3600_000;
    fs.utimesSync(info.worktreePath, new Date(old), new Date(old));

    // maxAge 设 1ms 确保命中（避免 mtime 精度问题）
    const cleaned = await cleanupOrphanedWorktrees(repo, 1);

    expect(cleaned).toBeGreaterThanOrEqual(1);
    // worktree 已被移除
    expect(fs.existsSync(info.worktreePath)).toBe(false);
    // 改动在移除前被导出成 patch
    const patches = listPatches();
    expect(patches.length).toBe(1);
    const content = fs.readFileSync(path.join(getTrashedPatchDir(), patches[0]), 'utf-8');
    expect(content).toContain('orphaned work');
  });
});
