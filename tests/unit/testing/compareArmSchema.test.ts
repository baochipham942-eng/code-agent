import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCompareArmShape,
  createCompareAgent,
  resolveEffectiveCompareArm,
} from '../../../src/host/testing/comparator/compareAgentFactory';
import {
  assertCompareArmsActivated,
  assertCompareArmsDistinct,
  runCompare,
} from '../../../src/host/testing/comparator/runCompare';
import { generateComparisonMarkdown } from '../../../src/host/testing/comparator/comparisonReport';
import {
  aggregateAssertionTrials,
  decideCaseWinner,
} from '../../../src/host/testing/comparator/assertionWinner';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type {
  CompareConfiguration,
  ExpectationResult,
  HarnessVariantConfig,
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
  it('reasoningEffort、memory、skills 与 harness 六键任一变化都进入有效签名（逐项放行）', () => {
    const fullHarness: HarnessVariantConfig = {
      name: 'arm',
      contextCompression: true,
      compressionPipeline: true,
      scaffoldProfile: false,
      thinkingInjection: true,
      hooksEnabled: false,
      toolMode: 'all',
    };
    const base: CompareConfiguration = {
      ...BASELINE,
      harness: fullHarness,
      memory: { longTerm: false, routingModel: 'memory-a' },
      reasoningEffort: 'medium',
    };
    const same: CompareConfiguration = { ...base, name: 'candidate' };
    expect(() => assertCompareArmsDistinct(base, same)).toThrow();

    // 2026-08-30 监工代笔（Grok 变异席抓出的盲区）：签名序列化删掉 toolMode 一键时 23/23 仍绿。
    // 这里把「两臂只差一键必须放行」按六键 + memory 两维 + reasoningEffort 逐个钉死。
    const harnessFlips: Array<Partial<HarnessVariantConfig>> = [
      { contextCompression: false },
      { compressionPipeline: false },
      { scaffoldProfile: true },
      { thinkingInjection: false },
      { hooksEnabled: true },
      { toolMode: 'deferred' },
    ];
    for (const flip of harnessFlips) {
      const candidate: CompareConfiguration = { ...same, harness: { ...fullHarness, ...flip } };
      expect(() => assertCompareArmsDistinct(base, candidate), JSON.stringify(flip)).not.toThrow();
    }
    expect(() => assertCompareArmsDistinct(base, { ...same, memory: { longTerm: true, routingModel: 'memory-a' } })).not.toThrow();
    expect(() => assertCompareArmsDistinct(base, { ...same, memory: { longTerm: false, routingModel: 'memory-b' } })).not.toThrow();
    expect(() => assertCompareArmsDistinct(base, { ...same, reasoningEffort: 'xhigh' })).not.toThrow();
    for (const skills of [['alpha'], ['beta'], ['alpha', 'beta']]) {
      expect(() => assertCompareArmsDistinct(base, { ...same, skills }), JSON.stringify(skills)).not.toThrow();
    }
    expect(() => assertCompareArmsDistinct(
      { ...base, skills: ['alpha', 'beta'] },
      { ...same, skills: ['beta', 'alpha', 'beta'] },
    )).toThrow();
  });

  it('构造期把长期记忆、路由模型、reasoning effort 与 harness 真传给 adapter', () => {
    const candidate: CompareConfiguration = {
      name: 'candidate',
      model: 'model-b',
      memory: { longTerm: true, routingModel: 'memory-b' },
      reasoningEffort: 'xhigh',
      skills: ['skill-b', 'skill-a', 'skill-b'],
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
      skills: readonly string[];
    };

    expect(adapter.persistLongTermMemory).toBe(true);
    expect(adapter.memoryRoutingModel).toBe('memory-b');
    expect(adapter.inferenceOptions?.reasoningEffort).toBe('xhigh');
    expect(adapter.modelConfig.reasoningEffort).toBe('high');
    expect(adapter.harness).toMatchObject({ hooksEnabled: true, contextCompression: false });
    expect(adapter.skills).toEqual(['skill-a', 'skill-b']);

    expect(resolveEffectiveCompareArm(BASELINE, BASELINE).memory.longTerm).toBe(false);
  });

  it('run stamp shape 分别记录两臂真实 memory 与六维 harness', () => {
    const candidate: CompareConfiguration = {
      name: 'candidate',
      memory: { longTerm: true },
      harness: { name: 'candidate', hooksEnabled: true, toolMode: 'all' },
    };
    expect(buildCompareArmShape(BASELINE, BASELINE)).toMatchObject({
      memory: false,
      harness: null,
    });
    expect(buildCompareArmShape(candidate, BASELINE)).toMatchObject({
      memory: true,
      skills: [],
      harness: { name: 'candidate', hooksEnabled: true, toolMode: 'all' },
    });
    expect(buildCompareArmShape({ ...candidate, skills: ['z', 'a', 'z'] }, BASELINE).skills)
      .toEqual(['a', 'z']);
  });
});

describe('skill 出场门', () => {
  async function runSkillComparison(activationCount: number, orientation: 0 | 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compare-skill-'));
    const testCase: TestCase = {
      id: 'skill-case',
      type: 'task',
      description: 'skill activation',
      prompt: 'run',
      expect: { response_contains: ['done'] },
    };
    const candidate: CompareConfiguration = { name: 'candidate', skills: ['x'] };
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => ({ responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] }),
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'mock' }),
      consumeSkillActivations: () => {
        const activations: Record<string, number> = {};
        if (config.name === 'candidate' && activationCount > 0) activations.x = activationCount;
        return activations;
      },
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
    const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(orientation as never);
    try {
      return await runCompare({ testCases: [testCase], baseline: BASELINE, candidate, makeAgent, runnerConfig });
    } finally {
      spy.mockRestore();
    }
  }

  it('固定两种盲分配朝向：candidate 零触发逐项排除，全部未出场结论首句固定', async () => {
    for (const orientation of [0, 1] as const) {
      const comparison = await runSkillComparison(0, orientation);
      expect(comparison.cases[0].assignment.A).toBe(orientation === 0 ? 'baseline' : 'candidate');
      expect(comparison.cases[0].excludedReason).toBe('skill_not_activated');
      expect(comparison.summary).toMatchObject({ totalCases: 0, skillNotActivatedPairs: 1 });
      expect(comparison.summary.verdict.startsWith('skill 未出场，结论不说明 skill 效果')).toBe(true);
      expect(() => assertCompareArmsActivated(comparison)).not.toThrow();
      expect(generateComparisonMarkdown(comparison)).toContain('实验组 skill 未出场，不计入 | 1');
    }
  });

  it('固定两种盲分配朝向：candidate 真实触发逐项计数并进入胜负 n', async () => {
    for (const orientation of [0, 1] as const) {
      const comparison = await runSkillComparison(2, orientation);
      expect(comparison.cases[0].excludedReason).toBeUndefined();
      expect(comparison.summary.totalCases).toBe(1);
      expect(comparison.summary.candidateSkillActivations).toEqual({ x: 2 });
      expect(comparison.summary.baselineSkillActivations).toEqual({});
    }
  });
});

describe('子代理触发次数从跑测一路到 pair_end', () => {
  async function runSpawnComparison(candidateSpawns: number, orientation: 0 | 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compare-spawn-'));
    const testCase: TestCase = {
      id: 'spawn-case',
      type: 'task',
      description: 'subagent spawns',
      prompt: 'run',
      expect: { response_contains: ['done'] },
    };
    const candidate: CompareConfiguration = {
      name: 'candidate',
      orchestration: { allowSwarm: true },
    };
    const makeAgent = (config: CompareConfiguration): AgentInterface => ({
      sendMessage: async () => ({ responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] }),
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'mock' }),
      consumeSubagentSpawns: () => (config.name === 'candidate' ? candidateSpawns : 0),
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
    const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(orientation as never);
    try {
      return await runCompare({ testCases: [testCase], baseline: BASELINE, candidate, makeAgent, runnerConfig });
    } finally {
      spy.mockRestore();
    }
  }

  it('两种盲分配朝向都把计数挂在正确的臂上', async () => {
    for (const orientation of [0, 1] as const) {
      const comparison = await runSpawnComparison(3, orientation);
      const candidateIsA = comparison.cases[0].assignment.A === 'candidate';
      // 摘掉 testRunner 的 consumeSubagentSpawns 或 comparator 的 subagentSpawnsA/B，这条立刻红。
      expect(comparison.cases[0].subagentSpawnsA, `orientation=${orientation}`).toBe(candidateIsA ? 3 : 0);
      expect(comparison.cases[0].subagentSpawnsB, `orientation=${orientation}`).toBe(candidateIsA ? 0 : 3);
    }
  });

  it('候选臂零触发时两臂都记 0（结果页据此打「未出场」）', async () => {
    const comparison = await runSpawnComparison(0, 0);
    expect(comparison.cases[0].subagentSpawnsA).toBe(0);
    expect(comparison.cases[0].subagentSpawnsB).toBe(0);
  });
});

describe('断言条级胜负', () => {
  it('candidate 3/4 对 baseline 2/4 时 candidate 赢，4/4 对 4/4 才平局', () => {
    expect(decideCaseWinner(result([true, true, false, false]), result([true, true, true, false])))
      .toMatchObject({ winner: 'candidate', passRateA: 0.5, passRateB: 0.75, assertionCount: 4 });
    expect(decideCaseWinner(result([true, true, true, true]), result([true, true, true, true])).winner)
      .toBe('tie');
  });

  it('LLM judge 结果不进入胜负', () => {
    const llmBaseline = result([false, false], { scoreAuthority: 'llm_judge' });
    const llmCandidate = result([true, true], { scoreAuthority: 'llm_judge' });
    expect(decideCaseWinner(llmBaseline, llmCandidate)).toMatchObject({
      winner: 'tie',
      assertionCount: 0,
    });
  });

  it('k>1 按每条断言 pass^k 聚合', () => {
    const aggregated = aggregateAssertionTrials([
      result([true, true], { skillActivations: { x: 1 } }),
      result([true, false], { skillActivations: { x: 2, y: 1 } }),
    ]);
    expect(aggregated.expectationResults?.map((row) => row.passed)).toEqual([true, false]);
    expect(aggregated.score).toBe(0.5);
    expect(aggregated.skillActivations).toEqual({ x: 3, y: 1 });
    expect(aggregated.trials).toHaveLength(2);
  });

  // 2026-08-30 监工代笔：原用例靠 crypto.randomInt(2) 盲分配，变异「realWinner 改读 ABGrader」约 25% 全绿
  // （Grok 席 6 跑 2 绿）。这里把分配朝向钉死，两种朝向各跑一遍；c/d 拆成两条独立断言链。
  async function referenceFixture() {
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
    return { testCase, makeAgent, runnerConfig, grade, candidate };
  }

  it('realWinner 只来自断言胜负：参考胜方翻转、盲分配两种朝向都不改变', async () => {
    const { testCase, makeAgent, runnerConfig, grade, candidate } = await referenceFixture();
    for (const baselineIsA of [0, 1]) {
      const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(baselineIsA as never);
      try {
        for (const label of ['A', 'B'] as const) {
          const result = await runCompare({
            testCases: [testCase], baseline: BASELINE, candidate, makeAgent, runnerConfig, llmCall: grade(label),
          });
          expect(result.cases[0].assignment.A, `orientation=${baselineIsA}`).toBe(baselineIsA === 0 ? 'baseline' : 'candidate');
          expect(result.cases[0].referenceWinner).toBe(label);
          expect(result.cases[0].assertionWinner).toBe('baseline');
          expect(result.cases[0].realWinner, `orientation=${baselineIsA} label=${label}`).toBe('baseline');
          expect(generateComparisonMarkdown(result)).toContain('| L1 基础题 | 1 | 0 | 0 |');
          expect(generateComparisonMarkdown(result)).toContain('参考 · 评审');
        }
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('computeSummary 只数 realWinner：参考胜方指向 candidate 时 summary 仍判 baseline', async () => {
    const { testCase, makeAgent, runnerConfig, grade, candidate } = await referenceFixture();
    for (const baselineIsA of [0, 1]) {
      const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(baselineIsA as never);
      try {
        const candidateLabel = baselineIsA === 0 ? 'B' : 'A';
        const result = await runCompare({
          testCases: [testCase], baseline: BASELINE, candidate, makeAgent, runnerConfig, llmCall: grade(candidateLabel),
        });
        expect(result.cases[0].assignment[candidateLabel]).toBe('candidate');
        expect(result.cases[0].referenceWinner).toBe(candidateLabel);
        expect(result.summary, `orientation=${baselineIsA}`).toMatchObject({ winner: 'baseline', baselineWins: 1, candidateWins: 0, ties: 0 });
      } finally {
        spy.mockRestore();
      }
    }
  });
});
