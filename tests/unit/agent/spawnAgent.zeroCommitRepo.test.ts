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
//   ⑦⑧ 分支引用损坏（垃圾字节 / 悬空 sha）：同⑤不变量——不降级（R3 返修：
//     exit 1 不只属于 unborn）
//   ⑨ 跨挂载点的非 git 目录（真独立卷）：仍判 no-repo 降级，子代理在原 cwd
//     跑起来（R3 返修真回归保护：旧 stderr 文本漏了 mount point 措辞会误判
//     探测失败不降级，独立挂载卷上派 coder 整条失败）
//   ⑩ .git 在场但 HEAD 文件损坏：不降级（该形态 stderr 与非 git 目录逐字相同，
//     旧文本判据的存量误降级；退出码 + fs 佐证按「.git 在场」判 unknown）
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** 直接改写当前分支的 loose ref 文件（refs/heads/<branch>）——绕过 git，模拟磁盘级损坏 */
async function writeCurrentBranchRef(repo: string, content: string): Promise<void> {
  const { stdout } = await execReal(`git -C ${quote(repo)} symbolic-ref HEAD`);
  const branch = stdout.trim().replace(/^refs\/heads\//, '');
  await fs.writeFile(path.join(repo, '.git', 'refs', 'heads', branch), content);
}

/** 有提交的仓库，当前分支 ref 内容是垃圾字节 */
async function makeGarbageRefRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await writeCurrentBranchRef(repo, 'garbage-not-a-sha\n');
  return repo;
}

/** 有提交的仓库，当前分支 ref 指向格式合法但不存在的 sha（悬空） */
async function makeDanglingRefRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await writeCurrentBranchRef(repo, '1234567890123456789012345678901234567890\n');
  return repo;
}

/** 有提交的仓库，.git/HEAD 文件本身损坏 */
async function makeBrokenHeadRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'garbage\n');
  return repo;
}

/**
 * 跨挂载点现场：hdiutil 建临时 dmg 独立卷并挂载（本机实测可用；无权限/无 hdiutil
 * 的环境返回 undefined，对应用例 ctx.skip 并由证据档的实机矩阵兜底）。
 * 用后由 detachScratchVolume 卸载并删 dmg。
 */
async function attachScratchVolume(): Promise<{ volRoot: string; dmg: string; plain: string }> {
  const volname = `NEOSPAWN-R4-${process.pid}`;
  const volRoot = path.join('/Volumes', volname);
  const dmg = path.join(os.tmpdir(), `${volname}.dmg`);
  await execReal(`hdiutil detach ${quote(volRoot)} >/dev/null 2>&1 || true`, { timeout: 15_000 });
  await execReal(
    `hdiutil create -size 16m -fs APFS -volname ${volname} -attach ${quote(dmg)}`,
    { timeout: 60_000 },
  );
  const plain = path.join(volRoot, 'plain');
  await fs.mkdir(plain, { recursive: true });
  return { volRoot, dmg, plain };
}

async function detachScratchVolume(mount: { volRoot: string; dmg: string }): Promise<void> {
  // 先常规卸载，失败再 -force 兜底（卷被短暂占用时 detach 会等待重试）
  await execReal(`hdiutil detach ${quote(mount.volRoot)} >/dev/null 2>&1 || true`, { timeout: 20_000 });
  await execReal(`hdiutil detach -force ${quote(mount.volRoot)} >/dev/null 2>&1 || true`, { timeout: 20_000 });
  await fs.rm(mount.dmg, { force: true });
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
/** 跨挂载点现场（⑨），收集阶段之后由 beforeAll 尝试建立；不可用时对应用例 skip */
let scratchMount: Awaited<ReturnType<typeof attachScratchVolume>> | undefined;

// hdiutil 在并行测试满载下可能远慢于单跑（实测 detach 从 0.2s 涨到 >10s 触发
// 默认 hook 限时），显式给足限时，避免夹具被误判为失败。
beforeAll(async () => {
  try {
    scratchMount = await attachScratchVolume();
  } catch {
    scratchMount = undefined;
  }
}, 120_000);

afterAll(async () => {
  if (scratchMount) {
    await detachScratchVolume(scratchMount).catch(() => undefined);
    scratchMount = undefined;
  }
}, 60_000);

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

  it('⑦ 当前分支 ref 是垃圾字节：不降级，可写子代理不在父目录跑起来', async () => {
    const repo = await makeGarbageRefRepo();
    scratchDirs.push(repo);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(repo),
    );

    // 不变量同⑤⑥：引用损坏不是「确认建不了」，只能落 unknown——不许降级。
    expect(result.success).toBe(false);
    expect(result.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('⑧ 当前分支 ref 指向不存在的 sha（悬空）：不降级，可写子代理不在父目录跑起来', async () => {
    const repo = await makeDanglingRefRepo();
    scratchDirs.push(repo);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(repo),
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('⑨ 跨挂载点的非 git 目录（真独立卷）：仍降级，子代理在原 cwd 里干活', async (ctx) => {
    if (!scratchMount) {
      ctx.skip('hdiutil 不可用，无法造独立挂载卷；该档由证据档实机矩阵 + 判据结构性保证');
      return;
    }
    // R3 真回归保护：旧 stderr 文本判据漏了 mount point 措辞，会把跨挂载点的
    // 普通（非 git）目录误判「探测失败」⇒ 不降级 ⇒ 硬建 worktree 失败，独立
    // 挂载卷上派 coder 整条不可用。新判据下退出码 + fs 佐证天然覆盖这一档。
    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(scratchMount.plain),
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(lastExecutorCwd()).toBe(scratchMount.plain);
  });

  it('⑩ .git 在场但 HEAD 文件损坏：不降级，可写子代理不在父目录跑起来', async () => {
    const repo = await makeBrokenHeadRepo();
    scratchDirs.push(repo);

    const result = await executeSpawnAgent(
      { role: 'coder', task: '写一个 hello.txt' },
      makeContext(repo),
    );

    // 该形态 git 的报错文案与非 git 目录逐字相同（旧文本判据会误判 no-repo 降级）；
    // 退出码 + fs 佐证按「.git 在场但 git 不认」判 unknown——fail-closed。
    expect(result.success).toBe(false);
    expect(result.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
