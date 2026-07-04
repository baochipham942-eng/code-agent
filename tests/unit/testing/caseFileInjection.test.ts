// ============================================================================
// GAIA 二期 — case 附件注入：files 字段把本地附件拷进沙箱工作目录
// ============================================================================
// GAIA 165 题里 38 题带附件（xlsx/png/pdf/…）。附件是 gated 数据不进 git，
// 落在 ~/.code-agent/gaia/files/，case 通过 files 字段声明，testRunner 跑前
// 拷进工作目录、跑后清理；dest 越界与 source 缺失都要 fail loud。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, access } from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { TestRunSummary } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

async function setupRun(suiteYaml: string, agent: AgentInterface) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-file-inject-'));
  const casesDir = path.join(root, 'cases');
  const workDir = path.join(root, 'work');
  await mkdir(casesDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), suiteYaml);

  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: workDir,
    defaultTimeout: 2000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, agent);

  return { root, workDir, run: () => runner.runAll() };
}

function agentWith(sendMessage: AgentInterface['sendMessage']): AgentInterface {
  return {
    sendMessage,
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
  };
}

function suiteWithFiles(source: string, dest?: string): string {
  return [
    'name: file-inject',
    'cases:',
    '  - id: attach-case',
    '    type: task',
    '    description: uses attachment',
    '    prompt: read the file',
    '    files:',
    `      - source: ${source}`,
    ...(dest ? [`        dest: ${dest}`] : []),
    '    expect:',
    '      response_contains: [ok]',
    '',
  ].join('\n');
}

describe('testRunner 附件注入（files 字段）', () => {
  it('跑前拷入工作目录（dest 默认 basename），agent 执行期可读', async () => {
    const attachDir = await mkdtemp(path.join(os.tmpdir(), 'gaia-attach-'));
    const source = path.join(attachDir, 'data.xlsx');
    await writeFile(source, 'xlsx-bytes');

    let seenContent: string | null = null;
    let workDirRef = '';
    const { workDir, run } = await setupRun(
      suiteWithFiles(source),
      agentWith(async () => {
        seenContent = fs.readFileSync(path.join(workDirRef, 'data.xlsx'), 'utf-8');
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      }),
    );
    workDirRef = workDir;

    const summary: TestRunSummary = await run();
    expect(summary.results[0].status).toBe('passed');
    expect(seenContent).toBe('xlsx-bytes');
  });

  it('case 结束后注入文件被清理（不污染同沙箱后续 case）', async () => {
    const attachDir = await mkdtemp(path.join(os.tmpdir(), 'gaia-attach-'));
    const source = path.join(attachDir, 'data.csv');
    await writeFile(source, 'a,b');

    const { workDir, run } = await setupRun(
      suiteWithFiles(source),
      agentWith(async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] })),
    );

    await run();
    await expect(access(path.join(workDir, 'data.csv'))).rejects.toThrow();
  });

  it('dest 越界工作目录 → case failed 且不落盘', async () => {
    const attachDir = await mkdtemp(path.join(os.tmpdir(), 'gaia-attach-'));
    const source = path.join(attachDir, 'evil.txt');
    await writeFile(source, 'evil');

    const { root, run } = await setupRun(
      suiteWithFiles(source, '../escaped.txt'),
      agentWith(async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] })),
    );

    const summary = await run();
    expect(summary.results[0].status).toBe('failed');
    expect(summary.results[0].failureReason).toMatch(/工作目录|escapes/);
    expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
  });

  it('source 不存在 → case failed，失败原因带路径（不静默跳过）', async () => {
    const missing = path.join(os.tmpdir(), 'gaia-attach-missing', 'nope.pdf');

    const { run } = await setupRun(
      suiteWithFiles(missing),
      agentWith(async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] })),
    );

    const summary = await run();
    expect(summary.results[0].status).toBe('failed');
    expect(summary.results[0].failureReason).toContain('nope.pdf');
  });
});
