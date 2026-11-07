// ============================================================================
// spawn_agent worktree 创建失败按探测档位下发 metadata.code（FB-634）
//
// 失败结果此前只有英文原始报错 + failureCode，renderer 无法把「不是 git 仓库 /
// 没有任何提交」翻成人话。本单让 prepareSpawnAgentWorktree 在 metadata 上追加
// code（WORKTREE_NO_REPO / WORKTREE_NO_COMMITS / WORKTREE_CREATE_FAILED），
// 同时钉住两条不变量：
//   - failureCode 仍是 worktree-create-failed（终态裁决/横幅逻辑不变）
//   - error 仍是原始报错原文（模型读的还是 raw cause，不能被文案顶掉）
// 探测档位与 resolveAgentWorktreeIsolation 的四态同源：no-repo / unborn 之外
// （探测通过仍失败、探测无结论）一律归 WORKTREE_CREATE_FAILED。
// 夹具复用 spawnAgent.zeroCommitRepo.test.ts 的真 git 建仓手法（不 mock exec）。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSpawnAgentWorktree } from '../../../src/host/agent/multiagentTools/spawnAgentWorktree';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const execReal = promisify(exec);
const GIT_TIMEOUT = 15_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runGit(cmd: string): Promise<void> {
  await execReal(cmd, { timeout: GIT_TIMEOUT });
}

async function makeNonGitDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'spawn-wt-meta-nogit-'));
}

async function makeZeroCommitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-wt-meta-zero-'));
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

/** 有提交的仓库但 .git/HEAD 损坏：探测落 unknown（非 no-repo/unborn）⇒ 归 other 档 */
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

function makeContext(): Pick<SubagentExecutionContext, 'swarmRunScope' | 'agentId'> {
  return { agentId: 'agent-wt-meta' };
}

describe('prepareSpawnAgentWorktree 失败结果按探测档位下发 metadata.code', () => {
  it('① 非 git 目录：WORKTREE_NO_REPO，failureCode 不变，error 保留原始报错', async () => {
    const dir = await makeNonGitDir();
    scratchDirs.push(dir);

    const prepared = await prepareSpawnAgentWorktree('agent-wt-meta', dir, makeContext());
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;

    const { failure } = prepared;
    expect(failure.metadata?.code).toBe('WORKTREE_NO_REPO');
    expect(failure.metadata?.failureCode).toBe(AgentFailureCode.WorktreeCreateFailed);
    expect(failure.metadata?.failureCode).toBe('worktree-create-failed');
    // error 仍是原始报错原文（exec 的 Command failed + git 的 fatal 输出）
    expect(failure.error).toContain('Failed to create worktree for agent: ');
    expect(failure.error).toContain('fatal:');
    expect(failure.error).toContain('not a git repository');
  });

  it('② 零提交仓库：WORKTREE_NO_COMMITS，error 保留 ambiguous argument 原文', async () => {
    const repo = await makeZeroCommitRepo();
    scratchDirs.push(repo);

    const prepared = await prepareSpawnAgentWorktree('agent-wt-meta', repo, makeContext());
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;

    const { failure } = prepared;
    expect(failure.metadata?.code).toBe('WORKTREE_NO_COMMITS');
    expect(failure.metadata?.failureCode).toBe('worktree-create-failed');
    expect(failure.error).toContain('Failed to create worktree for agent: ');
    expect(failure.error).toContain("ambiguous argument 'HEAD'");
  });

  it('③ 探测无结论（HEAD 损坏）：归 WORKTREE_CREATE_FAILED，不是前两档', async () => {
    const repo = await makeBrokenHeadRepo();
    scratchDirs.push(repo);

    const prepared = await prepareSpawnAgentWorktree('agent-wt-meta', repo, makeContext());
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;

    const { failure } = prepared;
    expect(failure.metadata?.code).toBe('WORKTREE_CREATE_FAILED');
    expect(failure.metadata?.failureCode).toBe('worktree-create-failed');
    expect(failure.error).toContain('Failed to create worktree for agent: ');
    expect(failure.error).toContain('fatal:');
  });
});
