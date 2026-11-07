// ============================================================================
// worktree 创建失败三档 code 的人话文案（FB-634）—— 端到端对着真实登记表
//
// metadata 不用夹具手拼，而是真的调 prepareSpawnAgentWorktree 造三类失败现场
// （非 git 目录 / 零提交仓库 / HEAD 损坏仓库），把 host 下发的 failure 原样喂给
// humanizeToolError。这样反向变异（host 摘掉 metadata.code 赋值）会让本文件变红：
// code 缺失 → 登记表不命中 → 返回 null，而非登记表文案。
// 断言：
//   - 命中 code 时逐字返回 zh/en 登记表文案（summary + detail）
//   - 文案里不含任何 git 黑话（fatal: / Command failed / git rev-parse）
//   - 原始 error 里确实有这些黑话（模型读的原文未被文案顶掉）
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareSpawnAgentWorktree } from '../../../src/host/agent/multiagentTools/spawnAgentWorktree';
import { humanizeToolError } from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { MultiagentExecutionResult } from '../../../src/host/agent/multiagentExecutionTypes';

const execReal = promisify(exec);
const GIT_TIMEOUT = 15_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runGit(cmd: string): Promise<void> {
  await execReal(cmd, { timeout: GIT_TIMEOUT });
}

async function makeNonGitDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'spawn-wt-copy-nogit-'));
}

async function makeZeroCommitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-wt-copy-zero-'));
  await runGit(`git init --quiet ${quote(dir)}`);
  return dir;
}

async function makeRepoWithCommit(): Promise<string> {
  const repo = await makeZeroCommitRepo();
  await runGit(
    `git -C ${quote(repo)} -c user.name=tester -c user.email=tester@example.com `
    + '-c commit.gpgsign=false commit --allow-empty --quiet -m init',
  );
  return repo;
}

/** 有提交的仓库但 .git/HEAD 损坏：探测落 unknown（非 no-repo/unborn）⇒ 归 CREATE_FAILED 档 */
async function makeBrokenHeadRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'garbage\n');
  return repo;
}

const GIT_JARGON = ['fatal:', 'Command failed', 'git rev-parse'] as const;

/** 现场档位 → 期望的 host metadata.code → 登记表键 */
const CASES = [
  { key: 'WORKTREE_NO_REPO', build: makeNonGitDir },
  { key: 'WORKTREE_NO_COMMITS', build: makeZeroCommitRepo },
  { key: 'WORKTREE_CREATE_FAILED', build: makeBrokenHeadRepo },
] as const;

const scratchDirs: string[] = [];
const realFailures = new Map<string, MultiagentExecutionResult>();

beforeAll(async () => {
  for (const testCase of CASES) {
    const dir = await testCase.build();
    scratchDirs.push(dir);
    const prepared = await prepareSpawnAgentWorktree('agent-wt-copy', dir, { agentId: 'agent-wt-copy' });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.failure.metadata?.code).toBe(testCase.key);
    realFailures.set(testCase.key, prepared.failure);
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
  realFailures.clear();
});

describe('worktree 创建失败 code 的人话文案（host 真实失败结果 × 真实登记表）', () => {
  for (const table of [
    { language: 'zh', t: zh, marker: '隔离副本' },
    { language: 'en', t: en, marker: 'isolated copy' },
  ] as const) {
    for (const { key } of CASES) {
      it(`[${table.language}] ${key} 返回登记表文案且不含 git 黑话`, () => {
        const failure = realFailures.get(key);
        expect(failure).toBeDefined();
        // 夹具自证：模型读的原始 error 里确实有 git 黑话
        expect(failure?.error).toContain('fatal:');

        const humanized = humanizeToolError(failure?.error, 'spawn_agent', table.t, failure?.metadata);

        const copy = table.t.toolErrors.codes[key];
        expect(humanized).toEqual({ summary: copy.summary, detail: copy.detail });
        expect(humanized?.summary).toContain(table.marker);

        const visible = `${humanized?.summary ?? ''}\n${humanized?.detail ?? ''}`;
        for (const jargon of GIT_JARGON) {
          expect(visible).not.toContain(jargon);
        }
      });
    }
  }

  it('三档 zh 文案各有可操作的下一步（detail 非空且不同于 summary）', () => {
    for (const { key } of CASES) {
      const copy = zh.toolErrors.codes[key];
      expect(copy.detail.length).toBeGreaterThan(0);
      expect(copy.detail).not.toBe(copy.summary);
    }
  });
});
