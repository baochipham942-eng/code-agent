// ============================================================================
// 零提交 git 目录里 spawn_agent 不再整条不可用（N-SPAWN-NOHEAD）
//
// 真机：用户在 git init 过但还没有任何提交的目录里派子代理，`git worktree add`
// 没有 HEAD 可指必然失败，spawn coder 报 worktree-create-failed，整条路不可用
// （2026-09-05 dev 槽 5 连炸）。
//
// 这里走真 executeSpawnAgent + 真 git（临时仓库），只 stub 掉最底层的
// SubagentExecutor.execute。断言落在「spawn 出来的子代理真的能干活」这个不变量上
// （成功 + executor 实际在哪个 cwd 里跑），不落在内部判据函数的返回值上：
//   ① 非 git 目录：spawn 成功，executor 在原 cwd 跑（既有降级行为不变）
//   ② 有提交的 git 仓库：spawn 成功，executor 在 worktree 里跑（正常隔离不变）
//   ③ 零提交仓库：spawn 成功，executor 在原 cwd 跑（本单修复）
//   ④ 零提交 + 外部引擎（forceWorktree 不允许降级）：显式失败，错误给可读原因
//   ⑤ 有提交仓库 + git 探测失败（不可执行）：spawn 显式失败，可写子代理不在父
//     目录跑起来（返修：探测失败不降级，fail-closed）
//   ⑥ worktree 的 .git 指向失效 gitdir：探测落 unknown 不降级，spawn 显式失败，
//     可写子代理不在父目录跑起来（R2 返修：仓库元数据失效 ≠ 确认非仓库）
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';
import { getSubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import type {
  SubagentExecutionContext,
  SubagentExecutionRequest,
} from '../../../src/host/agent/subagentExecutorTypes';

const execReal = promisify(exec);
const GIT_TIMEOUT = 15_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runGit(cmd: string): Promise<void> {
  await execReal(cmd, { timeout: GIT_TIMEOUT });
}

async function makeNonGitDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'spawn-nogit-'));
}

async function makeZeroCommitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-zero-commit-'));
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

/**
 * 造一个「.git 指向失效 gitdir」的 worktree 目录：git 还能执行，但
 * `git -C <dir> rev-parse --verify --quiet HEAD` 退出 128，stderr 是
 * `fatal: not a git repository: <path>`（无 `(or any of the parent directories)`
 * 括号段）——仓库元数据失效，不是「确认不在仓库内」（实测 git 2.50.1）。
 * 返回的两个目录都要进 scratchDirs（worktree 不在 repo 目录内）。
 */
async function makeBrokenGitdirWorktree(): Promise<{ repo: string; worktreeDir: string }> {
  const repo = await makeRepoWithCommit();
  const worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-broken-wt-'));
  await runGit(`git -C ${quote(repo)} worktree add ${quote(worktreeDir)} -b broken-wt-probe`);
  await fs.writeFile(
    path.join(worktreeDir, '.git'),
    `gitdir: ${path.join(repo, '.git', 'worktrees', 'GONE')}\n`,
  );
  return { repo, worktreeDir };
}

/**
 * 模拟「git 探测失败」：把 PATH 摘掉，被测链路里真实跑的 /bin/sh 找不到 git
 * （退出 127），而不是 mock 内部判据函数——断言要落在 executor 行为不变量上。
 */
async function withoutGitOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent-bin-for-probe-failure';
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

function makeContext(cwd: string): SubagentExecutionContext {
  return {
    runId: 'run-zero-commit-spawn',
    sessionId: 'session-zero-commit-spawn',
    workspace: cwd,
    cwd,
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver: undefined,
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: new AbortController().signal,
    currentToolCallId: 'tool-zero-commit-spawn',
    // 提供 parentContext，跳过 PermissionModeManager 依赖
    parentContext: {
      rules: [],
      memory: [],
      hooks: [],
      skills: [],
      mcpConnections: [],
      permissionMode: 'default',
      availableTools: [],
    },
  } as unknown as SubagentExecutionContext;
}

const scratchDirs: string[] = [];
let executeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  executeSpy = vi.spyOn(getSubagentExecutor(), 'execute').mockResolvedValue({
    success: true,
    output: '已写入 hello.txt',
    toolsUsed: ['Write'],
    iterations: 1,
  });
});

afterEach(async () => {
  executeSpy.mockRestore();
  await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

function lastExecutorCwd(): string | undefined {
  expect(executeSpy).toHaveBeenCalledTimes(1);
  const request = executeSpy.mock.calls[0][0] as SubagentExecutionRequest;
  return request.context.cwd;
}

describe('spawn_agent 在三类工作目录里的不变量', () => {
  it('① 非 git 目录：子代理在原 cwd 里干活（既有降级行为不变）', async () => {
    const dir = await makeNonGitDir();
    scratchDirs.push(dir);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(dir),
    );

    expect(result.success).toBe(true);
    expect(lastExecutorCwd()).toBe(dir);
  });

  it('② 有提交的 git 仓库：子代理在 worktree 里干活（正常隔离不变）', async () => {
    const repo = await makeRepoWithCommit();
    scratchDirs.push(repo);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(repo),
    );

    expect(result.success).toBe(true);
    const worktreeCwd = lastExecutorCwd();
    expect(worktreeCwd).toContain('code-agent-worktrees');
    // 前台完成后自动清理：executor 没写文件 → worktree 与分支不残留
    expect(await fs.stat(worktreeCwd!).then(() => true, () => false)).toBe(false);
  });

  it('③ 零提交仓库：子代理在原 cwd 里干活，不再 worktree-create-failed', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(repo),
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(lastExecutorCwd()).toBe(repo);
  });

  it('④ 零提交 + 外部引擎（forceWorktree 不降级）：显式失败并给可读原因', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt', engine: 'codex_cli' },
      makeContext(repo),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('初始提交');
    expect(result.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('⑤ 有提交仓库 + git 探测失败（不可执行）：spawn 显式失败，可写子代理不在父目录跑', async () => {
    const repo = await makeRepoWithCommit();
    scratchDirs.push(repo);

    const result = await withoutGitOnPath(() => executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(repo),
    ));

    // 不变量：探测失败不许降级无隔离——可写子代理没有在父工作目录里跑起来，
    // 而是照常 worktree 在创建处显式失败（fail-closed）。
    expect(result.success).toBe(false);
    expect(result.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('⑥ .git 指向失效 gitdir：不降级，可写子代理不在父目录跑起来', async () => {
    const { repo, worktreeDir } = await makeBrokenGitdirWorktree();
    scratchDirs.push(repo, worktreeDir);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(worktreeDir),
    );

    // 不变量同⑤：仓库元数据失效只能落 unknown，不许当 no-repo 降级——可写子代理
    // 没有在父工作目录（失效 worktree）里跑起来，而是在创建处显式失败。
    expect(result.success).toBe(false);
    expect(result.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
