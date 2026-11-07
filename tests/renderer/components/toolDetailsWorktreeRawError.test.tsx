// @vitest-environment jsdom
// ============================================================================
// ToolDetails worktree 创建失败卡片：中文原因上屏、原始 git 报错只在 toggle 后
// （FB-634）。metadata 不用夹具手拼，而是真的调 prepareSpawnAgentWorktree 造失败
// 现场，把 host 下发的 failure 原样喂给 ToolDetails——反向变异（host 摘掉
// metadata.code 赋值）会让本文件变红（登记表不命中 → 退回通用兜底文案）：
//   - 折叠态主文是登记表中文 summary + detail，正文不出现 fatal:/Command failed/
//     git rev-parse 任何一个 git 黑话
//   - 点「查看原始报错」后才露出含 fatal: 的原文（模型侧 error 未被改）
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ openPreview: vi.fn(), openSettingsTab: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: unknown) => unknown) =>
    selector({ createForkFromReply: vi.fn() }),
}));

import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { prepareSpawnAgentWorktree } from '../../../src/host/agent/multiagentTools/spawnAgentWorktree';
import type { ToolCall } from '../../../src/shared/contract';
import type { MultiagentExecutionResult } from '../../../src/host/agent/multiagentExecutionTypes';

afterEach(cleanup);

const execReal = promisify(exec);
const GIT_TIMEOUT = 15_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runGit(cmd: string): Promise<void> {
  await execReal(cmd, { timeout: GIT_TIMEOUT });
}

async function makeNonGitDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'spawn-wt-card-nogit-'));
}

async function makeZeroCommitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-wt-card-zero-'));
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

/** 有提交的仓库但 .git/HEAD 损坏：探测落 unknown ⇒ 归 CREATE_FAILED 档 */
async function makeBrokenHeadRepo(): Promise<string> {
  const repo = await makeRepoWithCommit();
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'garbage\n');
  return repo;
}

const scratchDirs: string[] = [];
let noRepoFailure: MultiagentExecutionResult | undefined;
let createFailedFailure: MultiagentExecutionResult | undefined;

beforeAll(async () => {
  const nonGit = await makeNonGitDir();
  scratchDirs.push(nonGit);
  const preparedNoRepo = await prepareSpawnAgentWorktree('agent-wt-card', nonGit, { agentId: 'agent-wt-card' });
  expect(preparedNoRepo.ok).toBe(false);
  if (!preparedNoRepo.ok) noRepoFailure = preparedNoRepo.failure;

  const brokenHead = await makeBrokenHeadRepo();
  scratchDirs.push(brokenHead);
  const preparedOther = await prepareSpawnAgentWorktree('agent-wt-card', brokenHead, { agentId: 'agent-wt-card' });
  expect(preparedOther.ok).toBe(false);
  if (!preparedOther.ok) createFailedFailure = preparedOther.failure;
}, 60_000);

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

function makeFailedSpawnCall(failure: MultiagentExecutionResult | undefined): ToolCall {
  expect(failure).toBeDefined();
  return {
    id: 'tool-wt-1',
    name: 'spawn_agent',
    arguments: { role: 'coder', task: '整理这份周报' },
    result: {
      toolCallId: 'tool-wt-1',
      success: false,
      error: failure?.error,
      metadata: failure?.metadata,
    },
  };
}

describe('ToolDetails worktree 创建失败卡片（host 真实失败结果 × 真实 zh 登记表）', () => {
  it('折叠态只显示中文原因与下一步，原始 git 报错不上屏', () => {
    render(React.createElement(ToolDetails, {
      toolCall: makeFailedSpawnCall(noRepoFailure),
    }));

    const body = document.body.textContent ?? '';
    expect(body).toContain('没能为子任务建隔离副本：当前文件夹不是 git 仓库');
    expect(body).toContain('请改在 git 仓库里做这件事，或让子任务不使用隔离副本。');
    for (const jargon of ['fatal:', 'Command failed', 'git rev-parse']) {
      expect(body).not.toContain(jargon);
    }
  });

  it('点「查看原始报错」后才露出原始 git 报错', () => {
    render(React.createElement(ToolDetails, {
      toolCall: makeFailedSpawnCall(noRepoFailure),
    }));

    expect(screen.queryByText(/fatal: not a git repository/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看原始报错' }));
    expect(screen.getByText(/fatal: not a git repository/)).toBeTruthy();
  });

  it('CREATE_FAILED 档也走登记表文案（含「原始报错可展开查看」指引）', () => {
    render(React.createElement(ToolDetails, {
      toolCall: makeFailedSpawnCall(createFailedFailure),
    }));

    const body = document.body.textContent ?? '';
    expect(body).toContain('没能为子任务建隔离副本');
    expect(body).toContain('请确认这个文件夹是可用的 git 仓库后重试，原始报错可在下方展开查看。');
    expect(body).not.toContain('fatal:');
  });
});
