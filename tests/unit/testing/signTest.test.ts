// ============================================================================
// --compare 配对显著性检验（精确二项 sign test）
// ============================================================================
// confidence=多数比例会误导：2 case 的 2:0 和 40 case 的 25:15 在报告里
// 看不出可信度差异。sign test 只看 decisive pair（排除 tie 和 excluded），
// 双尾精确二项 p 值 + 人话解读（显著 / 样本不足以判定差异）。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { signTestPValue } from '../../../src/host/testing/comparator/signTest';
import { generateComparisonMarkdown, generateComparisonConsole } from '../../../src/host/testing/comparator/comparisonReport';
import { runCompare } from '../../../src/host/testing/comparator/runCompare';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type { CompareConfiguration, TestCase, TestRunnerConfig } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

describe('signTestPValue 精确二项', () => {
  it('9:1 → p≈0.0215（双尾），显著', () => {
    expect(signTestPValue(9, 1)).toBeCloseTo(2 * (1 + 10) / 1024, 4);
  });

  it('2:0 → p=0.5，样本不足不显著', () => {
    expect(signTestPValue(2, 0)).toBeCloseTo(0.5, 6);
  });

  it('对称输入 p 相同', () => {
    expect(signTestPValue(3, 12)).toBeCloseTo(signTestPValue(12, 3), 10);
  });

  it('全平（0 decisive）→ p=1', () => {
    expect(signTestPValue(0, 0)).toBe(1);
  });

  it('势均力敌 5:5 → p=1（封顶）', () => {
    expect(signTestPValue(5, 5)).toBe(1);
  });

  it('大样本不溢出：100:50 显著', () => {
    const p = signTestPValue(100, 50);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.05);
  });
});

describe('接入 summary 与报告', () => {
  const BASELINE: CompareConfiguration = { name: 'baseline', model: 'm', provider: 'mock' };
  const CANDIDATE: CompareConfiguration = { name: 'candidate', model: 'm', provider: 'mock' };

  async function runnerConfig(): Promise<TestRunnerConfig> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-signtest-'));
    return {
      testCaseDir: root,
      resultsDir: path.join(root, 'results'),
      workingDirectory: root,
      defaultTimeout: 1000,
      stopOnFailure: false,
      verbose: false,
      parallel: false,
      maxParallel: 1,
      enableEvalCritic: false,
    };
  }

  it('summary 带 pValue，报告输出显著性解读', async () => {
    const cases: TestCase[] = Array.from({ length: 3 }, (_, i) => ({
      id: `case-${i}`,
      type: 'task' as const,
      description: `case ${i}`,
      prompt: `do thing ${i}`,
      expect: { response_contains: ['done'] },
    }));
    // candidate 恒强 → 3:0，p=0.25（样本不足）
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => config.name === 'candidate'
        ? {
            responses: ['done. ' + 'long detailed high-quality output. '.repeat(40)],
            toolExecutions: [
              { tool: 'bash', input: {}, output: 'ok', success: true, duration: 5, timestamp: 1 },
              { tool: 'write_file', input: {}, output: 'ok', success: true, duration: 5, timestamp: 2 },
            ],
            turnCount: 2,
            errors: [],
          }
        : { responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: cases, baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });

    expect(result.summary.candidateWins).toBe(3);
    expect(result.summary.pValue).toBeCloseTo(0.25, 6);

    const md = generateComparisonMarkdown(result);
    expect(md).toMatch(/p ?[=值]/);
    expect(md).toContain('样本不足');
    const console_ = generateComparisonConsole(result);
    expect(console_).toContain('0.25');
  });
});
