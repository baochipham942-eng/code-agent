// ============================================================================
// WP1-3b compare 无效对排除 — 没跑成的一侧不产生胜负信号
// ============================================================================
// 上一轮 MiMo 401 冒烟实锤：四次调用全 401、双侧零产出，comparator 照常
// 打分评成 2.0:2.0 平局——「无数据」被冒充成「势均力敌」。修法：任一侧
// infra_excluded 或零产出带错误（如 key 失效）→ 该 pair 标注排除，
// 不进胜负/均分统计，报告单列。能力性失败（跑了但做错）仍正常对比。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import { runCompare } from '../../../src/host/testing/comparator/runCompare';
import { generateComparisonMarkdown, generateComparisonConsole } from '../../../src/host/testing/comparator/comparisonReport';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type { CompareConfiguration, TestCase, TestRunnerConfig } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

const BASELINE: CompareConfiguration = { name: 'baseline', model: 'm', provider: 'mock' };
const CANDIDATE: CompareConfiguration = { name: 'candidate', model: 'm', provider: 'mock' };

const CASES: TestCase[] = [
  { id: 'ok-case', type: 'task', description: 'both sides fine', prompt: 'do ok', expect: { response_contains: ['done'] } },
  { id: 'broken-case', type: 'task', description: 'baseline side breaks', prompt: 'do broken', expect: { response_contains: ['done'] } },
];

async function runnerConfig(): Promise<TestRunnerConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-compare-excl-'));
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

function okOutput() {
  return { responses: ['done, all good'], toolExecutions: [], turnCount: 1, errors: [] };
}

describe('compare 无效对排除', () => {
  it('一侧 429（infra_excluded）→ pair 排除，不进胜负统计', async () => {
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async (prompt: string) => {
        if (config.name === 'baseline' && prompt === 'do broken') {
          throw new Error('Request failed with status code 429');
        }
        return okOutput();
      },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: CASES, baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });

    const broken = result.cases.find((c) => c.testId === 'broken-case');
    expect(broken?.excludedReason).toBeTruthy();
    expect(result.summary.excludedPairs).toBe(1);
    // 胜负/总数只含有效 pair
    expect(result.summary.totalCases).toBe(1);
    expect(result.summary.baselineWins + result.summary.candidateWins + result.summary.ties).toBe(1);
  });

  it('一侧零产出带错误（如 key 失效 401）→ 同样排除并带原因', async () => {
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => {
        if (config.name === 'candidate') {
          return { responses: [], toolExecutions: [], turnCount: 0, errors: ['Invalid API Key'] };
        }
        return okOutput();
      },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: [CASES[0]], baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });

    expect(result.summary.excludedPairs).toBe(1);
    expect(result.summary.totalCases).toBe(0);
    expect(result.cases[0].excludedReason).toContain('candidate');
    expect(result.cases[0].excludedReason).toContain('Invalid API Key');
  });

  it('能力性失败（有产出但断言不过）仍正常对比不排除', async () => {
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => {
        if (config.name === 'baseline') {
          return { responses: ['wrong answer entirely'], toolExecutions: [], turnCount: 1, errors: [] };
        }
        return okOutput();
      },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: [CASES[0]], baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });

    expect(result.summary.excludedPairs ?? 0).toBe(0);
    expect(result.summary.totalCases).toBe(1);
    expect(result.cases[0].excludedReason).toBeUndefined();
  });

  it('报告单列排除 pair 并注明原因', async () => {
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => {
        if (config.name === 'baseline') throw new Error('503 Service Unavailable');
        return okOutput();
      },
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    });

    const result = await runCompare({
      testCases: [CASES[0]], baseline: BASELINE, candidate: CANDIDATE,
      makeAgent, runnerConfig: await runnerConfig(),
    });

    const md = generateComparisonMarkdown(result);
    expect(md).toContain('排除');
    expect(md).toContain('503');
    const console_ = generateComparisonConsole(result);
    expect(console_).toContain('排除');
  });
});
