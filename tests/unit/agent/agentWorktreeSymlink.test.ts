// ============================================================================
// AgentWorktree — gitignored 目录 symlink 共享（真实 FS + 真实 git fixture）
// 这个文件【不】mock child_process / fs，跑真实 git worktree add + symlink，
// 验证功能 1：主仓库的 gitignored 顶层目录被 symlink 进新 worktree。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAgentWorktree } from '../../../src/main/agent/agentWorktree';

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

describe('AgentWorktree symlink sharing (real git)', () => {
  let repo: string;
  let createdWorktrees: string[] = [];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-repo-'));
    git(repo, 'init -q');
    // 初始 commit，否则没有 HEAD 无法 worktree add
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add README.md');
    git(repo, 'commit -q -m init');
    createdWorktrees = [];
  });

  afterEach(() => {
    // best-effort 清理 worktree 和临时仓库
    for (const wt of createdWorktrees) {
      try {
        execSync(`git worktree remove --force '${wt}'`, { cwd: repo, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(wt, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('① node_modules 等纯目录被 symlink 进 worktree', async () => {
    fs.writeFileSync(
      path.join(repo, '.gitignore'),
      'node_modules/\n.cache\n*.log\nsrc/generated/\n'
    );
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports={}');
    fs.mkdirSync(path.join(repo, '.cache'), { recursive: true });

    const agentId = `sym-${Date.now()}`;
    const info = await createAgentWorktree(agentId, repo);
    createdWorktrees.push(info.worktreePath);

    const linkPath = path.join(info.worktreePath, 'node_modules');
    expect(fs.existsSync(linkPath)).toBe(true);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // symlink 实际指向主仓库的 node_modules（内容可读）
    expect(
      fs.readFileSync(path.join(linkPath, 'pkg', 'index.js'), 'utf-8')
    ).toContain('module.exports');

    // .cache 也被 symlink
    const cacheLink = path.join(info.worktreePath, '.cache');
    expect(fs.lstatSync(cacheLink).isSymbolicLink()).toBe(true);
  });

  it('② 复杂 pattern（含 * 或 /）不会被 symlink', async () => {
    fs.writeFileSync(
      path.join(repo, '.gitignore'),
      '*.log\nsrc/generated/\nbuild/**\n'
    );
    // 即便磁盘上存在同名目录，复杂 pattern 也不应被处理
    fs.mkdirSync(path.join(repo, 'build'), { recursive: true });

    const agentId = `sym2-${Date.now()}`;
    const info = await createAgentWorktree(agentId, repo);
    createdWorktrees.push(info.worktreePath);

    // worktree 中不应出现 build 链接（build/** 是复杂 pattern）
    expect(fs.existsSync(path.join(info.worktreePath, 'build'))).toBe(false);
  });

  it('③ 条目对应的源目录不存在时跳过、不抛错', async () => {
    // node_modules 在 .gitignore 中声明，但主仓库里并不存在 → 应被跳过
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');

    const agentId = `sym3-${Date.now()}`;
    // 不应抛错
    const info = await createAgentWorktree(agentId, repo);
    createdWorktrees.push(info.worktreePath);

    expect(fs.existsSync(path.join(info.worktreePath, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(info.worktreePath, 'dist'))).toBe(false);
    // worktree 本身创建成功
    expect(fs.existsSync(path.join(info.worktreePath, 'README.md'))).toBe(true);
  });

  it('④ 无 .gitignore 时正常创建 worktree、不抛错', async () => {
    const agentId = `sym4-${Date.now()}`;
    const info = await createAgentWorktree(agentId, repo);
    createdWorktrees.push(info.worktreePath);
    expect(fs.existsSync(path.join(info.worktreePath, 'README.md'))).toBe(true);
  });
});
