// N-EVAL-FAILURE-AUTOHARVEST：过程形状断言在 TestRunner 全链上的接线。
// 走真实 YAML loader + TestRunner，agent 用脚本化 fake：
// - handoff_* 断言只在题目声明时采集（无关题不付查库炸点，PR#2019 R2 同款闸）
// - adapter 不接采集器（mock 形态）⇒ handoff_* 断言 fail-loud「没有证据源」
// - 超时被掐路径：handoff_not_proposed 违规已发生 ⇒ 补判红；证据交不出 ⇒ 记未判
// - max_tool_retries / required_steps 走 toolExecutions 证据源全链判定
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { HandoffProposalRecord, ToolExecutionRecord } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

vi.mock('../../../src/shared/constants/timeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants/timeouts')>();
  return { ...actual, TEST_TIMEOUTS: { ...actual.TEST_TIMEOUTS, TIMEOUT_TRACE_GRACE: 100 } };
});

function exec(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: 'Bash',
    input: { command: 'npm test' },
    output: '',
    success: true,
    duration: 10,
    timestamp: 1,
    ...overrides,
  };
}

function proposal(overrides: Partial<HandoffProposalRecord> = {}): HandoffProposalRecord {
  return {
    title: '转给设计专家继续',
    prompt: '接着把首页重做',
    source: 'assistant_tail',
    status: 'pending',
    createdAt: 1000,
    ...overrides,
  };
}

function fakeAgent(options: {
  response?: string;
  toolExecutions?: ToolExecutionRecord[];
  handoff?: () => HandoffProposalRecord[] | undefined;
} = {}): AgentInterface {
  return {
    sendMessage: async () => ({
      responses: [options.response ?? 'ok'],
      toolExecutions: options.toolExecutions ?? [],
      turnCount: 1,
      errors: [],
    }),
    reset: async () => undefined,
    getAgentInfo: () => ({ name: 'fake', model: 'fake-model', provider: 'mock' }),
    ...(options.handoff ? { collectHandoffProposals: async () => options.handoff!() } : {}),
  } as AgentInterface;
}

async function runSuite(yaml: string[], agent: AgentInterface, timeoutMs = 5000) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-process-assert-'));
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

const HANDOFF_NEGATIVE_CASE = [
  'name: handoff-negative',
  'cases:',
  '  - id: no-handoff-case',
  '    type: task',
  '    description: 负样本：题面自己能干完，不该发 handoff',
  '    prompt: 帮我润色这段文案',
  '    expectations:',
  '      - type: handoff_not_proposed',
  '        description: 不该发 handoff 提案',
  '        critical: true',
  '        params: {}',
];

const HANDOFF_POSITIVE_CASE = [
  'name: handoff-positive',
  'cases:',
  '  - id: handoff-case',
  '    type: task',
  '    description: 该交接给设计专家',
  '    prompt: 重做首页，设计部分交给设计专家',
  '    expectations:',
  '      - type: handoff_proposed',
  '        description: 该发 handoff 提案',
  '        critical: true',
  '        params:',
  '          match: 设计',
];

describe('TestRunner handoff 断言接线', () => {
  it('负样本：零提案 ⇒ 过，证据进 result', async () => {
    const summary = await runSuite(HANDOFF_NEGATIVE_CASE, fakeAgent({ handoff: () => [] }));
    const result = summary.results.find((r) => r.testId === 'no-handoff-case');

    expect(result?.status).toBe('passed');
    expect(result?.handoffProposals).toEqual([]);
  });

  it('误发提案 ⇒ 判红，失败原因点出断言类型', async () => {
    const summary = await runSuite(HANDOFF_NEGATIVE_CASE, fakeAgent({ handoff: () => [proposal()] }));
    const result = summary.results.find((r) => r.testId === 'no-handoff-case');

    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toContain('handoff_not_proposed');
  });

  it('adapter 不接采集器（mock 形态）⇒ 判红且写明没有证据源，不静默过', async () => {
    const summary = await runSuite(HANDOFF_NEGATIVE_CASE, fakeAgent());
    const result = summary.results.find((r) => r.testId === 'no-handoff-case');

    expect(result?.status).toBe('failed');
    expect(result?.expectationResults?.[0]?.evidence.details).toContain('没有证据源');
  });

  it('正向：提案命中 match ⇒ 过；零提案 ⇒ 红', async () => {
    const proposed = await runSuite(HANDOFF_POSITIVE_CASE, fakeAgent({ handoff: () => [proposal()] }));
    expect(proposed.results[0]?.status).toBe('passed');

    const silent = await runSuite(HANDOFF_POSITIVE_CASE, fakeAgent({ handoff: () => [] }));
    expect(silent.results[0]?.status).toBe('failed');
    expect(silent.results[0]?.failureReason).toContain('handoff_proposed');
  });

  it('普通题（无 handoff_* 断言）不采集 handoff：查库炸点不扩散成误红', async () => {
    let collected = 0;
    const agent = {
      ...fakeAgent(),
      collectHandoffProposals: async () => {
        collected += 1;
        throw new Error('handoff_proposals read exploded');
      },
    } as unknown as AgentInterface;
    const summary = await runSuite([
      'name: no-handoff-assert',
      'cases:',
      '  - id: plain-case',
      '    type: task',
      '    description: 普通题，与 handoff 无关',
      '    prompt: 你好',
      '    expectations:',
      '      - type: response_contains',
      '        description: 有回复',
      '        params:',
      '          text: ok',
    ], agent);

    expect(summary.results[0]?.status).toBe('passed');
    expect(collected).toBe(0);
  });
});

describe('TestRunner retry 预算与必经步骤接线', () => {
  it('max_tool_retries：连续失败超预算 ⇒ 判红；预算内 ⇒ 过', async () => {
    const yaml = [
      'name: retry-budget',
      'cases:',
      '  - id: retry-case',
      '    type: task',
      '    description: 同一命令最多连试两次',
      '    prompt: 跑测试直到过',
      '    expectations:',
      '      - type: max_tool_retries',
      '        description: 重试预算 2',
      '        critical: true',
      '        params:',
      '          budget: 2',
    ];
    const over = await runSuite(yaml, fakeAgent({
      toolExecutions: [exec({ success: false }), exec({ success: false }), exec({ success: false })],
    }));
    expect(over.results[0]?.status).toBe('failed');
    expect(over.results[0]?.failureReason).toContain('max_tool_retries');

    const within = await runSuite(yaml, fakeAgent({
      toolExecutions: [exec({ success: false }), exec({ success: true })],
    }));
    expect(within.results[0]?.status).toBe('passed');
  });

  it('required_steps：按序命中 ⇒ 过；缺步骤 ⇒ 红；零工具调用 ⇒ 红（不真空绿）', async () => {
    const yaml = [
      'name: required-steps',
      'cases:',
      '  - id: steps-case',
      '    type: task',
      '    description: 必须先读再改',
      '    prompt: 改文件',
      '    expectations:',
      '      - type: required_steps',
      '        description: Read 在 Edit 前',
      '        critical: true',
      '        params:',
      '          steps: ["^Read$", "^Edit$"]',
    ];
    const ordered = await runSuite(yaml, fakeAgent({
      toolExecutions: [exec({ tool: 'Read' }), exec({ tool: 'Edit' })],
    }));
    expect(ordered.results[0]?.status).toBe('passed');

    const missing = await runSuite(yaml, fakeAgent({
      toolExecutions: [exec({ tool: 'Read' })],
    }));
    expect(missing.results[0]?.status).toBe('failed');
    expect(missing.results[0]?.failureReason).toContain('required_steps');

    const empty = await runSuite(yaml, fakeAgent({ toolExecutions: [] }));
    expect(empty.results[0]?.status).toBe('failed');
    expect(empty.results[0]?.expectationResults?.[0]?.evidence.details).toContain('真空通过');
  });
});

describe('超时被掐路径（N-EVAL-TIMEOUT-K2-NEGASSERT 同口径）', () => {
  /** 一直跑到被 cancelActiveRun 掐掉，才带着这一轮的轨迹 return。 */
  function killedAgent(options: {
    toolExecutions?: ToolExecutionRecord[];
    handoff?: () => HandoffProposalRecord[] | undefined;
  } = {}): AgentInterface {
    let cancel: () => void = () => undefined;
    return {
      sendMessage: () => new Promise((resolve) => {
        cancel = () => resolve({
          responses: [],
          toolExecutions: options.toolExecutions ?? [],
          turnCount: 1,
          errors: [],
        });
      }),
      cancelActiveRun: async () => cancel(),
      reset: async () => undefined,
      getAgentInfo: () => ({ name: 'mock', model: 'mock', provider: 'mock' }),
      ...(options.handoff ? { collectHandoffProposals: async () => options.handoff!() } : {}),
    } as AgentInterface;
  }

  it('超时前已误发提案 ⇒ handoff_not_proposed 补判红，进 judged', async () => {
    const summary = await runSuite(HANDOFF_NEGATIVE_CASE, killedAgent({ handoff: () => [proposal()] }), 50);
    const result = summary.results[0];

    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', timeoutTraceAvailable: true });
    expect(result.timeoutExpectations).toEqual({ judged: ['handoff_not_proposed'], unjudged: [] });
    expect(result.failureReason).toMatch(/\[handoff_not_proposed\] /);
  });

  it('超时题且 adapter 交不出 handoff 证据 ⇒ 记未判，不拿零证据判绿', async () => {
    const summary = await runSuite(HANDOFF_NEGATIVE_CASE, killedAgent(), 50);
    const result = summary.results[0];

    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', timeoutTraceAvailable: true });
    expect(result.timeoutExpectations).toEqual({ judged: [], unjudged: ['handoff_not_proposed'] });
    expect(result.failureReason).not.toMatch(/\[handoff_not_proposed\]/);
  });

  it('超时题正向断言 handoff_proposed / required_steps 不补判（半截轨迹判不了终局）', async () => {
    const summary = await runSuite(HANDOFF_POSITIVE_CASE, killedAgent({ handoff: () => [] }), 50);
    const result = summary.results[0];

    expect(result.timeoutExpectations).toBeUndefined();
    expect(result.expectationResults).toBeUndefined();
  });

  it('超时题 max_tool_retries 补判：超预算违规已发生 ⇒ 补判红', async () => {
    const summary = await runSuite([
      'name: retry-timeout',
      'cases:',
      '  - id: retry-timeout-case',
      '    type: task',
      '    description: 超时题挂重试预算',
      '    prompt: do work',
      '    expectations:',
      '      - type: max_tool_retries',
      '        description: 预算 1',
      '        critical: true',
      '        params:',
      '          budget: 1',
    ], killedAgent({
      toolExecutions: [exec({ success: false }), exec({ success: false })],
    }), 50);
    const result = summary.results[0];

    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout', timeoutTraceAvailable: true });
    expect(result.timeoutExpectations).toEqual({ judged: ['max_tool_retries'], unjudged: [] });
    expect(result.failureReason).toMatch(/\[max_tool_retries\] /);
  });

  it('超时题没有 handoff 断言时 thunk 不被调用（无关题补判不查库）', async () => {
    let collected = 0;
    const agent = killedAgent();
    agent.collectHandoffProposals = async () => {
      collected += 1;
      throw new Error('should not be called');
    };
    const summary = await runSuite([
      'name: timeout-no-handoff',
      'cases:',
      '  - id: slow-no-handoff',
      '    type: task',
      '    description: 超时题，只挂重试预算',
      '    prompt: do work',
      '    expectations:',
      '      - type: max_tool_retries',
      '        description: 预算 3',
      '        critical: true',
      '        params:',
      '          budget: 3',
    ], agent, 50);
    const result = summary.results[0];

    expect(result).toMatchObject({ status: 'failed', failureStage: 'timeout' });
    expect(result.timeoutExpectations).toEqual({ judged: ['max_tool_retries'], unjudged: [] });
    expect(collected).toBe(0);
  });
});
