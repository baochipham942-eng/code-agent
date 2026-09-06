// ============================================================================
// worktree 隔离判据四态（真 git，不 mock exec）
//
//   ① 非 git 目录           → 降级 none（既有行为）
//   ② git 仓库且有提交       → worktree（既有行为）
//   ③ git 仓库但零提交       → 降级 none（N-SPAWN-NOHEAD：HEAD 解析不出来，
//                             `git worktree add` 必然失败）
//   ④ 探测本身失败           → 不降级，照常 worktree（返修：fail-closed。git 不可
//                             执行/超时/仓库读取失败 ≠ 确认建不了；降级会让可写
//                             子代理直接写父工作目录）
//   ⑤ 仓库引用损坏           → 不降级（R3 返修：分支 ref 垃圾字节/悬空 sha、HEAD
//                             文件损坏都属「仓库在但元数据坏」，不是确认建不了）
// forceWorktree / 显式 isolation: 'worktree' 与探测之前同级，探测结果（无论哪档）
// 都压不掉显式要求，照常 worktree，在创建处给可读原因。
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

/**
 * 模拟「探测本身失败」：把 PATH 摘掉，被测代码里真实跑的 /bin/sh 找不到 git
 * （退出 127），而不是 mock 一个假返回值——探测的判据就是真 git 的退出码/stderr。
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

/** 直接改写当前分支的 loose ref 文件（refs/heads/<branch>）——绕过 git，模拟磁盘级损坏 */
async function writeCurrentBranchRef(repo: string, content: string): Promise<void> {
  const { stdout } = await execReal(`git -C ${quote(repo)} symbolic-ref HEAD`);
  const branch = stdout.trim().replace(/^refs\/heads\//, '');
  await fs.writeFile(path.join(repo, '.git', 'refs', 'heads', branch), content);
}

/** 有提交的仓库，当前分支 ref 内容是垃圾字节（R3 返修场景：exit 1 不只属于 unborn） */
async function makeGarbageRefRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await writeCurrentBranchRef(repo, 'garbage-not-a-sha\n');
  return repo;
}

/** 有提交的仓库，当前分支 ref 指向格式合法但不存在的 sha（悬空，对象库里没有） */
async function makeDanglingRefRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await writeCurrentBranchRef(repo, '1234567890123456789012345678901234567890\n');
  return repo;
}

/** 有提交的仓库，.git/HEAD 文件本身损坏——git 对它的报错文案与非 git 目录逐字相同，
 *  旧 stderr 文本判据会误判成 no-repo（降级）；退出码 + fs 佐证按「.git 在场」判 unknown */
async function makeBrokenHeadRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'garbage\n');
  return repo;
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
  it('① 非 git 目录默认降级为 none（真阴对照）；显式 worktree 不被压掉', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-'));
    scratchDirs.push(dir);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: dir })).toBe('none');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: dir })).toBe('worktree');
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

  it('③ 零提交仓库（有 .git 无 HEAD）默认降级为 none（真阴对照）；显式 worktree 不被压掉', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);
    const nested = path.join(repo, 'nested');
    await fs.mkdir(nested);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo })).toBe('none');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: repo })).toBe('worktree');
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

describe('④ 探测失败不降级（真 git 不可执行，fail-closed）', () => {
  // 探测失败 ≠ 确认建不了。有提交的仓库里 git 探测挂掉（不可执行/超时/仓库读取
  // 失败）时若降级 none，可写子代理会直接写父工作目录——必须保持 worktree。
  it('git 不可执行：有提交的仓库也不返回 none，保持 worktree', async () => {
    const repo = await makeRepoWithCommit();
    scratchDirs.push(repo);

    await withoutGitOnPath(async () => {
      expect(
        await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo }),
      ).toBe('worktree');
    });
  });

  it('git 不可执行：显式 worktree 不被探测失败覆盖', async () => {
    const repo = await makeRepoWithCommit();
    scratchDirs.push(repo);

    await withoutGitOnPath(async () => {
      expect(
        await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: repo }),
      ).toBe('worktree');
    });
  });
});

describe('⑤ 仓库引用损坏不降级（真 git 夹具，R3 返修）', () => {
  // 「仓库在但引用坏」≠「确认建不了 worktree」：降级会让可写子代理写父工作目录。
  // 旧判据读 stderr 文本，这几档要么被误归类（HEAD 损坏的文案与非 git 逐字相同），
  // 要么随 git 版本/locale 漂移；新判据只看退出码 + 文件系统佐证。
  it('当前分支 ref 是垃圾字节：不返回 none，保持 worktree', async () => {
    const repo = await makeGarbageRefRepo();
    scratchDirs.push(repo);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo })).toBe('worktree');
  });

  it('当前分支 ref 指向不存在的 sha（悬空）：不返回 none，保持 worktree', async () => {
    const repo = await makeDanglingRefRepo();
    scratchDirs.push(repo);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo })).toBe('worktree');
  });

  it('.git 在场但 HEAD 文件损坏：不返回 none（该形态的 stderr 与非 git 目录逐字相同）', async () => {
    const repo = await makeBrokenHeadRepo();
    scratchDirs.push(repo);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read', 'Write'], cwd: repo })).toBe('worktree');
  });

  it('显式 worktree / forceWorktree 在引用损坏下同样不被压掉', async () => {
    const repo = await makeGarbageRefRepo();
    scratchDirs.push(repo);

    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], explicit: 'worktree', cwd: repo })).toBe('worktree');
    expect(await resolveAgentWorktreeIsolation({ tools: ['Read'], forceWorktree: true, cwd: repo })).toBe('worktree');
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
