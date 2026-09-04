// N-EVAL-MEMORY：case 级记忆声明在 TestRunner 全链上的接线。
// 走真实 YAML loader + TestRunner，agent 用脚本化 fake：
// - 声明了 memory 的 case，runner 起跑前把声明交给 adapter（seed 就在那一刻落盘）
// - 没声明的 case 拿到 undefined（清掉上一题，不串题）
// - 声明写错（enabled 不是 true / seed 文件名非法）→ fail-loud，零 agent 调用
// - seed 落盘抛错（比如没有隔离数据目录）→ 显式红，不静默跑成一次能力数据
// - adapter 不给记忆落账（mock 模式）→ memory_recalled / memory_written 判红且写明「没有证据源」
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { EvalCaseMemory } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

type MemorySignals = ReturnType<NonNullable<AgentInterface['consumeMemorySignals']>>;

function fakeAgent(options: {
  response?: string;
  signals?: MemorySignals;
  seedThrows?: string;
} = {}): AgentInterface & { seen: Array<EvalCaseMemory | undefined>; calls: number } {
  const seen: Array<EvalCaseMemory | undefined> = [];
  const agent = {
    seen,
    calls: 0,
    sendMessage: async () => {
      agent.calls += 1;
      return { responses: [options.response ?? 'ok'], toolExecutions: [], turnCount: 1, errors: [] };
    },
    reset: async () => undefined,
    getAgentInfo: () => ({ name: 'fake', model: 'fake-model', provider: 'mock' }),
    configureCaseMemory: async (memory: EvalCaseMemory | undefined) => {
      seen.push(memory);
      if (memory?.enabled === true && options.seedThrows) throw new Error(options.seedThrows);
    },
    ...(options.signals
      ? { consumeMemorySignals: () => options.signals as MemorySignals }
      : {}),
  };
  return agent as AgentInterface & { seen: Array<EvalCaseMemory | undefined>; calls: number };
}

async function runSuite(yaml: string[], agent: AgentInterface) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-case-memory-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), yaml.join('\n'));
  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 5000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, agent);
  return runner.runAll();
}

const MEMORY_CASE = [
  'name: case-memory',
  'cases:',
  '  - id: with-memory',
  '    type: task',
  '    description: 有记忆声明的题',
  '    prompt: Orchid 的主视觉色是什么',
  '    memory:',
  '      enabled: true',
  '      seed:',
  '        files:',
  '          - name: mem-orchid.md',
  '            content: "内部项目 Orchid 的主视觉色是 #2F6D4F。"',
  '    expectations:',
  '      - type: memory_recalled',
  '        description: Orchid 记忆被注入',
  '        params:',
  '          entries: ["mem-orchid"]',
  '  - id: without-memory',
  '    type: task',
  '    description: 没有记忆声明的题',
  '    prompt: 你好',
  '    expectations:',
  '      - type: response_contains',
  '        description: 有回复',
  '        params:',
  '          text: ok',
];

describe('TestRunner case-level memory wiring', () => {
  it('把声明交给 adapter，没声明的题拿到 undefined（不串题）', async () => {
    const agent = fakeAgent({
      signals: { memoryRecall: { injections: 1, entries: ['mem-orchid.md'] }, memoryWrites: 0 },
    });
    const summary = await runSuite(MEMORY_CASE, agent);

    expect(agent.seen).toHaveLength(2);
    expect(agent.seen[0]).toMatchObject({ enabled: true });
    expect(agent.seen[0]?.seed?.files?.[0]?.name).toBe('mem-orchid.md');
    expect(agent.seen[1]).toBeUndefined();
    expect(summary.results.find((r) => r.testId === 'with-memory')?.status).toBe('passed');
  });

  it('记忆落账进 result，memory_recalled 读得到它', async () => {
    const agent = fakeAgent({
      signals: { memoryRecall: { injections: 3, entries: ['mem-orchid.md'] }, memoryWrites: 2 },
    });
    const summary = await runSuite(MEMORY_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'with-memory');

    expect(result?.memoryRecall).toEqual({ injections: 3, entries: ['mem-orchid.md'] });
    expect(result?.memoryWrites).toBe(2);
    expect(result?.status).toBe('passed');
  });

  it('adapter 不给记忆落账（mock 模式）⇒ 判红且写明没有证据源，不静默过', async () => {
    const agent = fakeAgent();
    const summary = await runSuite(MEMORY_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'with-memory');

    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toContain('memory_recalled');
    expect(
      result?.expectationResults?.find((r) => r.expectation.type === 'memory_recalled')?.evidence.details,
    ).toContain('没有证据源');
  });

  it('声明写错（seed 文件名非法）⇒ fail-loud，一次 agent 都不调', async () => {
    const agent = fakeAgent();
    const summary = await runSuite([
      'name: case-memory-bad',
      'cases:',
      '  - id: bad-seed-name',
      '    type: task',
      '    description: 非法 seed 文件名',
      '    prompt: hi',
      '    memory:',
      '      enabled: true',
      '      seed:',
      '        files:',
      '          - name: ../escape.md',
      '            content: x',
      '    expectations:',
      '      - type: response_contains',
      '        description: 有回复',
      '        params:',
      '          text: ok',
    ], agent);

    const result = summary.results[0];
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('不合法');
    expect(agent.calls).toBe(0);
  });

  it('seed 落盘抛错（没有隔离数据目录）⇒ 显式红，不静默跑下去', async () => {
    const agent = fakeAgent({ seedThrows: '记忆题需要每题隔离的数据目录：CODE_AGENT_DATA_DIR 未设置' });
    const summary = await runSuite(MEMORY_CASE, agent);
    const result = summary.results.find((r) => r.testId === 'with-memory');

    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toContain('CODE_AGENT_DATA_DIR');
    expect(agent.calls).toBe(1); // 只有 without-memory 那题跑了
  });
});

describe('记忆信号在全部轮次跑完后才消费（审查 #1638）', () => {
  it('follow_up_prompts 场景：consumeMemorySignals 在最后一轮之后调用，不在首轮后', async () => {
    let callsAtConsume = -1;
    const base = fakeAgent();
    const agent = {
      ...base,
      consumeMemorySignals: () => {
        callsAtConsume = base.calls;
        return { memoryWrites: 2 } as MemorySignals;
      },
    } as unknown as AgentInterface;
    const results = await runSuite([
      'name: multi-turn-memory',
      'cases:',
      '  - id: two-follow-ups',
      '    type: task',
      '    description: 第二轮才落盘的记忆题',
      '    prompt: 记住 Orchid 的主视觉色是墨绿',
      '    follow_up_prompts:',
      '      - 再记一条：辅色是浅金',
      '      - 现在复述两条',
      '    expectations:',
      '      - type: response_contains',
      '        description: 跑得起来即可',
      '        params:',
      '          text: ok',
    ], agent);
    // 首轮 + 两条 follow-up = 3 次 sendMessage；首轮后就消费会把 callsAtConsume 卡在 1
    expect(base.calls).toBe(3);
    expect(callsAtConsume).toBe(3);
    expect(results.results[0]?.memoryWrites).toBe(2);
  });
});
