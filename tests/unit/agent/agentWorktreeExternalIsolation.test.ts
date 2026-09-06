// ============================================================================
// worktree 隔离判据三档（真 git，不 mock exec）
//
//   ① 非 git 目录           → 降级 none（既有行为）
//   ② git 仓库且有提交       → worktree（既有行为）
//   ③ git 仓库但零提交       → 降级 none（N-SPAWN-NOHEAD 新增：HEAD 解析不出来，
//                             `git worktree add` 必然失败）
// forceWorktree（外部写执行器）三档都不降级，照常 worktree，在创建处给可读原因。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveAgentWorktreeIsolation,
  worktreeFailureHint,
} from '../../../src/host/agent/agentWorktree';

const execReal = promisify(exec);
const GIT_TIMEOUT = 15_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runGit(cmd: string): Promise<void> {
  await execReal(cmd, { timeout: GIT_TIMEOUT });
}

/** git init 过但从未 commit：.git 在、HEAD 解析不出来（病灶现场） */
async function makeZeroCommitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zero-commit-repo-'));
  await runGit(`git init --quiet ${quote(dir)}`);
  return dir;
}

async function makeRepoWithCommit(): Promise<string> {
  const dir = await makeZeroCommitRepo();
  await runGit(
    `git -C ${quote(dir)} -c user.name=tester -c user.email=tester@example.com `
    + '-c commit.gpgsign=false commit --allow-empty --quiet -m init',
  );
  return dir;
}

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

describe('external subagent worktree isolation', () => {
  it('never downgrades a forced external engine to shared cwd outside git', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-isolation-'));
    scratchDirs.push(nonGitDir);

    expect(await resolveAgentWorktreeIsolation({
      tools: ['Read'],
      cwd: nonGitDir,
      forceWorktree: true,
    })).toBe('worktree');
    expect(await resolveAgentWorktreeIsolation({
      tools: ['Read'],
      cwd: nonGitDir,
    })).toBe('none');
  });

  it('passes the created worktree cwd into the executor context', async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), 'src/host/agent/multiagentTools/spawnAgent.ts'),
      'utf8',
    );

    expect(source).toContain('const executorContext: SubagentExecutionContext = {\n        ...context, cwd,');
    expect(source).toContain("forceWorktree: engineResolution.engine !== 'native'");
  });
});

describe('worktree 隔离判据三档（真 git）', () => {
  it('① 非 git 目录降级为 none，即使显式要求 worktree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-'));
    scratchDirs.push(dir);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: dir })).toBe('none');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: dir })).toBe('none');
  });

  it('② 有提交的 git 仓库照常 worktree（含子目录，git 自己向上找仓库）', async () => {
    const repo = await makeRepoWithCommit();
    scratchDirs.push(repo);
    const nested = path.join(repo, 'nested', 'deep');
    await fs.mkdir(nested, { recursive: true });

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo })).toBe('worktree');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: nested })).toBe('worktree');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: repo })).toBe('worktree');
  });

  it('③ 零提交仓库（有 .git 无 HEAD）降级为 none，即使显式要求 worktree', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);
    const nested = path.join(repo, 'nested');
    await fs.mkdir(nested);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo })).toBe('none');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: repo })).toBe('none');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: nested })).toBe('none');
  });

  it('forceWorktree 在零提交仓库同样不降级（在创建处失败并给可读原因）', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);

    expect(await resolveAgentWorktreeIsolation({
      tools: ['Read'],
      cwd: repo,
      forceWorktree: true,
    })).toBe('worktree');
  });
});

describe('worktreeFailureHint 按失败原因给人话', () => {
  it('零提交仓库 → 指向「先做初始提交」，不是「确保在 git 仓库里」', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);

    const hint = await worktreeFailureHint(repo);
    expect(hint).toContain('初始提交');
    expect(hint).not.toContain('Ensure you are in a git repository');
  });

  it('非 git 目录 → 保持原有英文提示', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-hint-'));
    scratchDirs.push(dir);

    expect(await worktreeFailureHint(dir)).toBe('Ensure you are in a git repository.');
  });

  it('有提交的仓库 → 默认英文提示（不误报零提交）', async () => {
    const repo = await makeRepoWithCommit();
    scratchDirs.push(repo);

    expect(await worktreeFailureHint(repo)).toBe('Ensure you are in a git repository.');
  });
});
