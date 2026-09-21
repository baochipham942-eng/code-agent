// N-SKILL-TRIGGER-EVAL：skill 触发断言在 TestRunner 全链上的接线。
// 走真实 YAML loader + TestRunner，agent 用脚本化 fake：
// - consumeSkillSignals 在全部轮次跑完、断言求值之前被调用（第二轮才触发也算数）
// - adapter 不接记录器（mock 形态）⇒ skill_* 断言 fail-loud「没有证据源」，不静默过
// - 声明的 skill 没装进本题上下文 ⇒ fail-loud「配置错」，负样本不许真空绿
// - 超时被掐路径：误触发已发生 ⇒ 补判红；证据交不出 ⇒ 记未判
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { CaseSkillSignals } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

vi.mock('../../../src/shared/constants/timeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants/timeouts')>();
  return { ...actual, TEST_TIMEOUTS: { ...actual.TEST_TIMEOUTS, TIMEOUT_TRACE_GRACE: 100 } };
});

function fakeAgent(options: {
  response?: string;
  signals?: () => CaseSkillSignals;
} = {}): AgentInterface & { calls: number } {
  const agent = {
    calls: 0,
    sendMessage: async () => {
      agent.calls += 1;
      return { responses: [options.response ?? 'ok'], toolExecutions: [], turnCount: 1, errors: [] };
    },
    reset: async () => undefined,
    getAgentInfo: () => ({ name: 'fake', model: 'fake-model', provider: 'mock' }),
    ...(options.signals ? { consumeSkillSignals: async () => options.signals!() } : {}),
  };
  return agent as AgentInterface & { calls: number };
}

async function runSuite(yaml: string[], agent: AgentInterface, timeoutMs = 5000) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-skill-trigger-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), yaml.join('\n'));
  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: timeoutMs,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, agent);
  return runner.runAll();
}

const NEGATIVE_CASE = [
  'name: skill-trigger',
  'cases:',
  '  - id: neg-case',
  '    type: task',
  '    description: 负样本：装了 contract-review 但题面是润色文案',
  '    prompt: 帮我润色这段文案',
  '    expectations:',
  '      - type: skill_not_triggered',
  '        description: contract-review 不该触发',
  '        critical: true',
  '        params:',
  '          skills: ["contract-review"]',
];

const POSITIVE_CASE = [
  'name: skill-trigger',
  'cases:',
  '  - id: imp-case',
  '    type: task',
  '    description: 隐式触发：题面不点名 xlsx 但任务该触发它',
  '    prompt: 把这堆数据整理成 Excel',
  '    expectations:',
  '      - type: skill_triggered',
  '        description: xlsx 该被触发',
  '        critical: true',
  '        params:',
  '          skills: ["xlsx"]',
];

describe('TestRunner skill 触发断言接线', () => {
  it('负样本：零触发 + skill 在上下文 ⇒ 过，证据进 result', async () => {
    const agent = fakeAgent({ signals: () => ({ skillActivations: {}, skillContext: ['contract-review'] }) });
    const summary = await runSuite(NEGATIVE_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'neg-case');

    expect(result?.status).toBe('passed');
    expect(result?.skillContext).toEqual(['contract-review']);
    expect(result?.skillActivations).toEqual({});
  });

  it('误触发 ⇒ 判红，失败原因点出断言类型与触发计数', async () => {
    const agent = fakeAgent({ signals: () => ({ skillActivations: { 'contract-review': 1 }, skillContext: ['contract-review'] }) });
    const summary = await runSuite(NEGATIVE_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'neg-case');

    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toContain('skill_not_triggered');
    expect(result?.expectationResults?.[0]?.evidence.actual).toEqual(['contract-review×1']);
  });

  it('adapter 不接记录器（mock 形态）⇒ 判红且写明没有证据源，不静默过', async () => {
    const agent = fakeAgent();
    const summary = await runSuite(NEGATIVE_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'neg-case');

    expect(result?.status).toBe('failed');
    expect(result?.expectationResults?.[0]?.evidence.details).toContain('没有证据源');
  });

  it('声明的 skill 没装进本题上下文 ⇒ 判红写明配置错，不许真空绿', async () => {
    const agent = fakeAgent({ signals: () => ({ skillActivations: {}, skillContext: ['xlsx'] }) });
    const summary = await runSuite(NEGATIVE_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'neg-case');

    expect(result?.status).toBe('failed');
    expect(result?.expectationResults?.[0]?.evidence.details).toContain('没装进本题上下文');
  });

  it('隐式触发：该触发的真触发了 ⇒ 过；没触发 ⇒ 红', async () => {
    const triggered = await runSuite(POSITIVE_CASE, fakeAgent({ signals: () => ({ skillActivations: { xlsx: 1 }, skillContext: ['xlsx'] }) }));
    expect(triggered.results[0]?.status).toBe('passed');

    const silent = await runSuite(POSITIVE_CASE, fakeAgent({ signals: () => ({ skillActivations: {}, skillContext: ['xlsx'] }) }));
    expect(silent.results[0]?.status).toBe('failed');
    expect(silent.results[0]?.failureReason).toContain('skill_triggered');
  });

  it('多轮题：第二轮才触发的 skill 也算数（信号在全部轮次后才交出）', async () => {
    let round = 0;
    const base = fakeAgent();
    const agent = {
      ...base,
      sendMessage: async () => {
        round += 1;
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      },
      consumeSkillSignals: async () => ({
        skillActivations: round >= 2 ? { xlsx: 1 } : {},
        skillContext: ['xlsx'],
      }),
    } as unknown as AgentInterface;
    const summary = await runSuite([
      'name: skill-trigger-multiturn',
      'cases:',
      '  - id: imp-late-trigger',
      '    type: task',
      '    description: 第二轮才触发',
      '    prompt: 先看看这些数据',
      '    follow_up_prompts:',
      '      - 整理成 Excel 表格',
      '    expectations:',
      '      - type: skill_triggered',
      '        description: xlsx 该被触发',
      '        critical: true',
      '        params:',
      '          skills: ["xlsx"]',
    ], agent);

    expect(round).toBe(2);
    expect(summary.results[0]?.status).toBe('passed');
  });
});

describe('超时被掐路径（N-EVAL-TIMEOUT-K2-NEGASSERT 同口径）', () => {
  /** 一直跑到被 cancelActiveRun 掐掉，才带着这一轮的轨迹 return。 */
  function killedAgent(signals?: () => CaseSkillSignals): AgentInterface {
    let cancel: () => void = () => undefined;
    return {
      sendMessage: () => new Promise((resolve) => {
        cancel = () => resolve({ responses: [], toolExecutions: [], turnCount: 1, errors: [] });
      }),
      cancelActiveRun: async () => cancel(),
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
      ...(signals ? { consumeSkillSignals: async () => signals() } : {}),
    };
  }

  it('超时前误触发已发生 ⇒ 补判红，进 judged', async () => {
    const summary = await runSuite(NEGATIVE_CASE, killedAgent(() => ({
      skillActivations: { 'contract-review': 1 },
      skillContext: ['contract-review'],
    })), 50);
    const result = summary.results[0];

    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', timeoutTraceAvailable: true });
    expect(result.timeoutExpectations).toEqual({ judged: ['skill_not_triggered'], unjudged: [] });
    expect(result.failureReason).toMatch(/\[skill_not_triggered\] /);
  });

  it('超时题且 adapter 交不出证据 ⇒ 记未判，不拿零证据判绿', async () => {
    const summary = await runSuite(NEGATIVE_CASE, killedAgent(), 50);
    const result = summary.results[0];

    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', timeoutTraceAvailable: true });
    expect(result.timeoutExpectations).toEqual({ judged: [], unjudged: ['skill_not_triggered'] });
    expect(result.failureReason).not.toMatch(/\[skill_not_triggered\]/);
  });

  it('超时题正向断言 skill_triggered 不补判（半截没触发 ≠ 不会触发）', async () => {
    const summary = await runSuite(POSITIVE_CASE, killedAgent(() => ({
      skillActivations: {},
      skillContext: ['xlsx'],
    })), 50);
    const result = summary.results[0];

    expect(result.timeoutExpectations).toBeUndefined();
    expect(result.expectationResults).toBeUndefined();
  });
});
