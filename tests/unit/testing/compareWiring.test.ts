// ============================================================================
// WP1-3 ABComparator 接线 — eval-ci --compare 的执行骨架
// ============================================================================
// comparator.ts 完整实现但全仓零调用方。runCompare 是薄接线层：
// 每个 CompareConfiguration 建独立 agent + TestRunner，喂给 ABComparator
// 做成对盲测（paired 盲测统计功效远高于整轮总分对比）。只接线不重写。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { runCompare } from '../../../src/host/testing/comparator/runCompare';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type { CompareConfiguration, TestCase } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

const BASELINE: CompareConfiguration = { name: 'baseline', model: 'model-a', provider: 'mock' };
const CANDIDATE: CompareConfiguration = { name: 'candidate', model: 'model-a', provider: 'mock', systemPrompt: 'be better' };

const CASES: TestCase[] = [
  {
    id: 'case-1',
    type: 'task',
    description: 'first case',
    prompt: 'do thing one',
    expect: { response_contains: ['done'] },
  },
  {
    id: 'case-2',
    type: 'task',
    description: 'second case',
    prompt: 'do thing two',
    expect: { response_contains: ['done'] },
  },
];

function makeAgentFactory(log: Array<{ config: string; prompt: string }>) {
  return (config: CompareConfiguration): AgentInterface => ({
    sendMessage: async (prompt: string) => {
      log.push({ config: config.name, prompt });
      // candidate 输出明显更强（更长响应 + 工具调用），heuristic grader 应判它赢
      if (config.name === 'candidate') {
        return {
          responses: ['done. ' + 'detailed explanation of the work performed. '.repeat(30)],
          toolExecutions: [
            { tool: 'bash', input: {}, output: 'ok', success: true, duration: 5, timestamp: 1 },
            { tool: 'write_file', input: {}, output: 'ok', success: true, duration: 5, timestamp: 2 },
          ],
          turnCount: 2,
          errors: [],
        };
      }
      return { responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] };
    },
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock', model: config.model ?? 'm', provider: config.provider ?? 'p' }),
  });
}

async function makeWorkDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-compare-'));
  await mkdir(path.join(root, 'results'), { recursive: true });
  return root;
}

describe('runCompare 接线', () => {
  it('每个 case 在两个配置下各真跑一次（paired），结果含全部非 skip case', async () => {
    const log: Array<{ config: string; prompt: string }> = [];
    const root = await makeWorkDir();

    const result = await runCompare({
      testCases: CASES,
      baseline: BASELINE,
      candidate: CANDIDATE,
      makeAgent: makeAgentFactory(log),
      runnerConfig: {
        testCaseDir: root,
        resultsDir: path.join(root, 'results'),
        workingDirectory: root,
        defaultTimeout: 1000,
        stopOnFailure: false,
        verbose: false,
        parallel: false,
        maxParallel: 1,
        enableEvalCritic: false,
      },
    });

    expect(result.cases).toHaveLength(2);
    // 每 case 两配置各一跑 = 4 次
    expect(log).toHaveLength(4);
    for (const testCase of CASES) {
      const runs = log.filter((l) => l.prompt === testCase.prompt);
      expect(runs.map((r) => r.config).sort()).toEqual(['baseline', 'candidate']);
    }
  });

  it('盲测后正确 unblind：更强的 candidate 赢，与 A/B 随机分配无关', async () => {
    const root = await makeWorkDir();

    const result = await runCompare({
      testCases: CASES,
      baseline: BASELINE,
      candidate: CANDIDATE,
      makeAgent: makeAgentFactory([]),
      runnerConfig: {
        testCaseDir: root,
        resultsDir: path.join(root, 'results'),
        workingDirectory: root,
        defaultTimeout: 1000,
        stopOnFailure: false,
        verbose: false,
        parallel: false,
        maxParallel: 1,
        enableEvalCritic: false,
      },
    });

    expect(result.summary.winner).toBe('candidate');
    expect(result.summary.candidateWins).toBe(2);
  });

  it('skip case 不进对比', async () => {
    const root = await makeWorkDir();
    const withSkip: TestCase[] = [
      ...CASES,
      { id: 'case-skip', type: 'task', description: 'skipped', prompt: 'nope', expect: {}, skip: true },
    ];

    const result = await runCompare({
      testCases: withSkip,
      baseline: BASELINE,
      candidate: CANDIDATE,
      makeAgent: makeAgentFactory([]),
      runnerConfig: {
        testCaseDir: root,
        resultsDir: path.join(root, 'results'),
        workingDirectory: root,
        defaultTimeout: 1000,
        stopOnFailure: false,
        verbose: false,
        parallel: false,
        maxParallel: 1,
        enableEvalCritic: false,
      },
    });

    expect(result.cases.map((c) => c.testId)).toEqual(['case-1', 'case-2']);
  });
});
