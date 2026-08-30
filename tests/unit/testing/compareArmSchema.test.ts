import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCompareArmShape,
  createCompareAgent,
  resolveEffectiveCompareArm,
} from '../../../src/host/testing/comparator/compareAgentFactory';
import { assertCompareArmsDistinct, runCompare } from '../../../src/host/testing/comparator/runCompare';
import { generateComparisonMarkdown } from '../../../src/host/testing/comparator/comparisonReport';
import {
  aggregateAssertionTrials,
  decideCaseWinner,
} from '../../../src/host/testing/comparator/assertionWinner';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type {
  CompareConfiguration,
  ExpectationResult,
  TestCase,
  TestResult,
  TestRunnerConfig,
} from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

const BASELINE: CompareConfiguration = {
  name: 'baseline',
  model: 'model-a',
  provider: 'mock',
};

function rows(passes: boolean[]): ExpectationResult[] {
  return passes.map((passed, index) => ({
    expectation: {
      type: 'response_contains',
      description: `assertion-${index}`,
      params: { text: `marker-${index}` },
    },
    passed,
    evidence: { actual: passed, expected: true },
    duration: 1,
  }));
}

function result(passes: boolean[], overrides: Partial<TestResult> = {}): TestResult {
  return {
    testId: 'case',
    description: 'case',
    status: passes.every(Boolean) ? 'passed' : passes.some(Boolean) ? 'partial' : 'failed',
    duration: 1,
    startTime: 0,
    endTime: 1,
    toolExecutions: [],
    responses: ['response'],
    errors: [],
    turnCount: 1,
    score: passes.length > 0 ? passes.filter(Boolean).length / passes.length : 0,
    scoreAuthority: 'deterministic_assertion',
    expectationResults: rows(passes),
    ...overrides,
  };
}

describe('统一实验臂 schema', () => {
  it('reasoningEffort 与六维 harness 任一变化都进入有效签名', () => {
    const reasoning: CompareConfiguration = { name: 'candidate', reasoningEffort: 'xhigh' };
    const hooks: CompareConfiguration = {
      name: 'candidate',
      harness: { name: 'candidate', hooksEnabled: true },
    };
    const contextCompression: CompareConfiguration = {
      name: 'candidate',
      harness: { name: 'candidate', contextCompression: false },
    };

    expect(() => assertCompareArmsDistinct(BASELINE, reasoning)).not.toThrow();
    expect(() => assertCompareArmsDistinct(BASELINE, hooks)).not.toThrow();
    expect(() => assertCompareArmsDistinct(BASELINE, contextCompression)).not.toThrow();
  });

  it('构造期把长期记忆、路由模型、reasoning effort 与 harness 真传给 adapter', () => {
    const candidate: CompareConfiguration = {
      name: 'candidate',
      model: 'model-b',
      memory: { longTerm: true, routingModel: 'memory-b' },
      reasoningEffort: 'xhigh',
      harness: {
        name: 'candidate',
        contextCompression: false,
        compressionPipeline: false,
        scaffoldProfile: true,
        thinkingInjection: false,
        hooksEnabled: true,
        toolMode: 'all',
      },
    };
    const adapter = createCompareAgent(candidate, BASELINE, {
      workingDirectory: '/tmp',
      apiKey: 'test-key',
      requestPermission: async () => true,
    }) as unknown as {
      persistLongTermMemory: boolean;
      memoryRoutingModel?: string;
      inferenceOptions?: { reasoningEffort?: string };
      modelConfig: { reasoningEffort?: string };
      harness?: { hooksEnabled?: boolean; contextCompression?: boolean };
    };

    expect(adapter.persistLongTermMemory).toBe(true);
    expect(adapter.memoryRoutingModel).toBe('memory-b');
    expect(adapter.inferenceOptions?.reasoningEffort).toBe('xhigh');
    expect(adapter.modelConfig.reasoningEffort).toBe('high');
    expect(adapter.harness).toMatchObject({ hooksEnabled: true, contextCompression: false });

    expect(resolveEffectiveCompareArm(BASELINE, BASELINE).memory.longTerm).toBe(false);
  });

  it('run stamp shape 分别记录两臂真实 memory 与六维 harness', () => {
    const candidate: CompareConfiguration = {
      name: 'candidate',
      memory: { longTerm: true },
      harness: { name: 'candidate', hooksEnabled: true, toolMode: 'all' },
    };
    expect(buildCompareArmShape(BASELINE, BASELINE, false)).toMatchObject({
      memory: false,
      harness: null,
    });
    expect(buildCompareArmShape(candidate, BASELINE, false)).toMatchObject({
      memory: true,
      harness: { name: 'candidate', hooksEnabled: true, toolMode: 'all' },
    });
  });
});

describe('断言条级胜负', () => {
  it('candidate 3/4 对 baseline 2/4 时 candidate 赢，4/4 对 4/4 才平局', () => {
    expect(decideCaseWinner(result([true, true, false, false]), result([true, true, true, false])))
      .toMatchObject({ winner: 'candidate', passRateA: 0.5, passRateB: 0.75, assertionCount: 4 });
    expect(decideCaseWinner(result([true, true, true, true]), result([true, true, true, true])).winner)
      .toBe('tie');
  });

  it('LLM judge 结果不进入胜负，infra/not_run/cost_exceeded 排除', () => {
    const llmBaseline = result([false, false], { scoreAuthority: 'llm_judge' });
    const llmCandidate = result([true, true], { scoreAuthority: 'llm_judge' });
    expect(decideCaseWinner(llmBaseline, llmCandidate)).toMatchObject({
      winner: 'tie',
      assertionCount: 0,
    });

    for (const status of ['infra_excluded', 'not_run', 'cost_exceeded'] as const) {
      expect(decideCaseWinner(result([true]), result([true], { status })).excludedReason)
        .toContain(status);
    }
  });

  it('k>1 按每条断言 pass^k 聚合', () => {
    const aggregated = aggregateAssertionTrials([
      result([true, true]),
      result([true, false]),
    ]);
    expect(aggregated.expectationResults?.map((row) => row.passed)).toEqual([true, false]);
    expect(aggregated.score).toBe(0.5);
    expect(aggregated.trials).toHaveLength(2);
  });

  it('ABGrader 参考胜方任意翻转都不改变 summary 结论', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compare-reference-'));
    const testCase: TestCase = {
      id: 'assertion-case',
      type: 'task',
      description: 'deterministic winner',
      prompt: 'run',
      expect: {},
      layer: 'L1 基础题',
      expectations: [
        { type: 'response_contains', description: 'done', params: { text: 'done' } },
        { type: 'tool_called', description: 'write', params: { tool: 'write_file' } },
      ],
    };
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => ({
        responses: ['done'],
        toolExecutions: config.name === 'baseline'
          ? [{ tool: 'write_file', input: {}, output: 'ok', success: true, duration: 1, timestamp: 1 }]
          : [],
        turnCount: 1,
        errors: [],
      }),
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'mock' }),
    });
    const runnerConfig: TestRunnerConfig = {
      testCaseDir: root,
      resultsDir: path.join(root, 'results'),
      workingDirectory: root,
      defaultTimeout: 1000,
      stopOnFailure: false,
      verbose: false,
      parallel: false,
      maxParallel: 1,
    };
    const grade = (winner: 'A' | 'B') => async () => JSON.stringify({
      scoreA: {
        content: { correctness: 5, completeness: 5, accuracy: 5 },
        structure: { organization: 5, formatting: 5, usability: 5 },
      },
      scoreB: {
        content: { correctness: 1, completeness: 1, accuracy: 1 },
        structure: { organization: 1, formatting: 1, usability: 1 },
      },
      winner,
      reasoning: 'reference only',
    });
    const candidate: CompareConfiguration = { name: 'candidate', systemPrompt: 'variant' };

    const referenceA = await runCompare({
      testCases: [testCase], baseline: BASELINE, candidate, makeAgent, runnerConfig, llmCall: grade('A'),
    });
    const referenceB = await runCompare({
      testCases: [testCase], baseline: BASELINE, candidate, makeAgent, runnerConfig, llmCall: grade('B'),
    });

    expect(referenceA.summary).toMatchObject({ winner: 'baseline', baselineWins: 1, candidateWins: 0 });
    expect(referenceB.summary).toMatchObject({ winner: 'baseline', baselineWins: 1, candidateWins: 0 });
    expect(referenceA.cases[0].referenceWinner).not.toBe(referenceB.cases[0].referenceWinner);
    expect(generateComparisonMarkdown(referenceA)).toContain('| L1 基础题 | 1 | 0 | 0 |');
    expect(generateComparisonMarkdown(referenceA)).toContain('参考 · 评审');
  });
});
