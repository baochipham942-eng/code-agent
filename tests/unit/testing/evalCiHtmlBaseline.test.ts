import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import { CONFIG_DIR_NEW } from '../../../src/host/config/configPaths';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalCiScript = path.join(repoRoot, 'scripts', 'eval-ci.ts');

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeResult(overrides: Partial<TestResult>): TestResult {
  return {
    testId: 'case-a',
    description: 'desc',
    status: 'passed',
    duration: 100,
    startTime: 0,
    endTime: 100,
    toolExecutions: [],
    responses: ['ok'],
    errors: [],
    turnCount: 1,
    score: 1,
    scoreAuthority: 'deterministic_assertion',
    ...overrides,
  };
}

function makeSummary(results: TestResult[]): TestRunSummary {
  return {
    runId: 'baseline-run',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    partial: results.filter((r) => r.status === 'partial').length,
    infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
    averageScore: results.length ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0,
    results,
    environment: { model: 'mock-model', provider: 'mock', workingDirectory: '/tmp/work' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

async function createWorkRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-eval-ci-html-'));
  roots.push(root);
  return root;
}

async function writeSuite(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'suite.yaml'), [
    'name: smoke',
    'cases:',
    '  - id: case-a',
    '    type: task',
    '    description: mock pass case',
    '    prompt: 列出当前目录',
    '    expect:',
    '      response_contains: [package.json]',
    '',
  ].join('\n'));
}

async function writeSplit(root: string): Promise<void> {
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(
    path.join(root, '.claude', 'eval-splits.json'),
    JSON.stringify({
      version: 1,
      seed: 'test-seed',
      createdAt: '2026-07-26T00:00:00.000Z',
      heldIn: ['case-a'],
      heldOut: [],
      control: ['case-a'],
      safety: [],
    }),
  );
}

async function runEvalCi(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(process.execPath, [tsxCli, evalCiScript, ...args], {
    cwd,
    timeout: 30_000,
    env: {
      ...process.env,
      CODE_AGENT_EVAL_NO_SANDBOX: 'true',
      CODE_AGENT_DATA_DIR: path.join(cwd, '.runtime-data'),
    },
  });
}

function resultsDir(root: string): string {
  return path.join(root, CONFIG_DIR_NEW, 'test-results');
}

describe('eval-ci HTML report baseline flow', () => {
  it('无 --split 的日常路径从版本化资产只读取 held-in，并兼容仅有 .claude/test-cases 的 worktree', async () => {
    const root = await createWorkRoot();
    const caseDir = path.join(root, '.claude', 'test-cases');
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, 'suite.yaml'), [
      'name: slicing',
      'cases:',
      '  - id: case-a',
      '    type: task',
      '    description: held-in',
      '    prompt: 列出当前目录',
      '    expect:',
      '      response_contains: [package.json]',
      '  - id: case-b',
      '    type: task',
      '    description: held-out',
      '    prompt: 列出当前目录',
      '    expect:',
      '      response_contains: [package.json]',
      '',
    ].join('\n'));
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(
      path.join(root, '.claude', 'eval-splits.json'),
      JSON.stringify({
        version: 1,
        seed: 'test-seed',
        createdAt: '2026-07-26T00:00:00.000Z',
        heldIn: ['case-a'],
        heldOut: ['case-b'],
        control: ['case-a'],
        safety: [],
      }),
    );

    await runEvalCi(root, ['--scope', 'smoke']);

    const report = JSON.parse(
      await readFile(path.join(resultsDir(root), 'latest-report.json'), 'utf8'),
    ) as { results: Array<{ testId: string }> };
    expect(report.results.map((result) => result.testId)).toEqual(['case-a']);
  });

  it('writes the only eval HTML report after baseline compare so latest-report.html includes baseline delta', async () => {
    const root = await createWorkRoot();
    await writeSuite(path.join(root, CONFIG_DIR_NEW, 'test-cases'));
    await writeSplit(root);

    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([
      makeResult({ testId: 'case-a', status: 'failed', score: 0, failureReason: 'previous failure' }),
    ]), 'baseline-sha', 'real');

    await runEvalCi(root, ['--scope', 'smoke']);

    const html = await readFile(path.join(resultsDir(root), 'latest-report.html'), 'utf8');
    expect(html).toContain('Baseline Delta');
    expect(html).toContain('case-a');

    const timestampedHtml = (await readdir(resultsDir(root))).filter((entry) => /^report-[0-9T]+\.html$/.test(entry));
    expect(timestampedHtml).toHaveLength(1);
  });

  it('--case-dir writes HTML without baseline delta', async () => {
    const root = await createWorkRoot();
    const caseDir = path.join(root, 'external-cases');
    await writeSuite(caseDir);

    await runEvalCi(root, ['--scope', 'smoke', '--case-dir', caseDir]);

    const html = await readFile(path.join(resultsDir(root), 'latest-report.html'), 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('Baseline Delta');
  });
});
