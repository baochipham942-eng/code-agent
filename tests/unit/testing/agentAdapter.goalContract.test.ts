// ============================================================================
// B6b-①：StandaloneAgentAdapter goal 契约 per-case 注入
// ============================================================================
// 接线先例 = 批 6 configureUserSimulation：testRunner 每 case 注入，reset() 清除，
// 未配置时存量行为零变化（config.goalContract undefined → AgentLoop 不建
// GoalModeController）。goal 观测事件（goal_gate / goal_complete）落
// GoalRunRecord，经 getGoalRunRecord() 暴露给 testRunner 做断言锚点。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';
import type { AgentEvent } from '../../../src/shared/contract';

interface CapturedLoopConfig {
  goalContract?: { goal: string; verifyCommand?: string; allowSwarm?: boolean; maxTurns: number };
  onEvent: (event: AgentEvent) => void;
}

function goalCompleteEvent(status: 'met' | 'aborted'): AgentEvent {
  return { type: 'goal_complete', data: { status, turns: 1, tokensUsed: 1 } };
}

const capturedConfigs: CapturedLoopConfig[] = [];
let scriptedGoalEvents: AgentEvent[] = [];

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    private config: CapturedLoopConfig;
    constructor(config: CapturedLoopConfig) {
      capturedConfigs.push(config);
      this.config = config;
    }
    async run(): Promise<void> {
      for (const event of scriptedGoalEvents) {
        this.config.onEvent(event);
      }
    }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  SYSTEM_PROMPT: 'test system prompt',
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {},
}));

vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    startSession: vi.fn(),
    endSession: vi.fn(),
    handleEvent: vi.fn(),
    createAdapter: vi.fn(() => ({})),
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

function makeAdapter(): StandaloneAgentAdapter {
  return new StandaloneAgentAdapter({
    workingDirectory: '/tmp',
    modelConfig: { provider: 'mock', model: 'mock-model' },
  });
}

beforeEach(() => {
  capturedConfigs.length = 0;
  scriptedGoalEvents = [];
});

describe('StandaloneAgentAdapter goal contract injection', () => {
  it('passes no goalContract when not configured (legacy eval behavior unchanged)', async () => {
    const adapter = makeAdapter();
    await adapter.sendMessage('hello');
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0].goalContract).toBeUndefined();
    expect(adapter.getGoalRunRecord()).toBeUndefined();
  });

  it('passes a built GoalContract with prompt fallback and allowSwarm=false', async () => {
    const adapter = makeAdapter();
    adapter.configureGoalContract({ verify_command: 'test -f x.txt', max_turns: 9 });
    await adapter.sendMessage('创建文件 x.txt');
    expect(capturedConfigs).toHaveLength(1);
    const contract = capturedConfigs[0].goalContract;
    expect(contract).toBeDefined();
    expect(contract!.goal).toBe('创建文件 x.txt');
    expect(contract!.verifyCommand).toBe('test -f x.txt');
    expect(contract!.maxTurns).toBe(9);
    expect(contract!.allowSwarm).toBe(false);
  });

  it('captures goal_gate and goal_complete events into the goal run record', async () => {
    const adapter = makeAdapter();
    adapter.configureGoalContract({ verify_command: 'true' });
    scriptedGoalEvents = [
      { type: 'goal_gate', data: { gate: 0, pass: true, verdict: 'allow_finalize' } },
      { type: 'goal_gate', data: { gate: 1, pass: true, verdict: 'allow_finalize' } },
      { type: 'goal_complete', data: { status: 'met', turns: 3, tokensUsed: 42 } },
    ];
    await adapter.sendMessage('做点事');
    const record = adapter.getGoalRunRecord();
    expect(record).toBeDefined();
    expect(record!.status).toBe('met');
    expect(record!.degraded).toBe(false);
    expect(record!.gateEvents).toEqual([
      { gate: 0, pass: true, verdict: 'allow_finalize' },
      { gate: 1, pass: true, verdict: 'allow_finalize' },
    ]);
  });

  it('does not record goal events when no contract is configured', async () => {
    const adapter = makeAdapter();
    scriptedGoalEvents = [
      { type: 'goal_complete', data: { status: 'met', turns: 1, tokensUsed: 1 } },
    ];
    await adapter.sendMessage('普通 case');
    expect(adapter.getGoalRunRecord()).toBeUndefined();
  });

  it('orphaned loop events do not pollute the next case record (audit R2-H1: timeout leak)', async () => {
    const adapter = makeAdapter();
    // case 1（goal）：模拟超时——run 挂着没发终态，testRunner 已结案进下个 case
    adapter.configureGoalContract({ verify_command: 'true' });
    await adapter.sendMessage('case 1');
    const orphanedOnEvent = capturedConfigs[0].onEvent;

    // case 2（goal）：正常开跑
    await adapter.reset();
    adapter.configureGoalContract({ verify_command: 'true' });
    await adapter.sendMessage('case 2');

    // 孤儿 loop 的残余事件此刻才到——不得写进 case 2 的落账
    orphanedOnEvent({ type: 'goal_gate', data: { gate: 0, pass: false, verdict: 'repair_prompt' } });
    orphanedOnEvent(goalCompleteEvent('aborted'));

    const record = adapter.getGoalRunRecord();
    expect(record?.gateEvents ?? []).toEqual([]);
    expect(record?.status).toBeUndefined();
  });

  it('getGoalRunRecord returns a frozen snapshot, not a live reference (audit R2-M1: ghost events)', async () => {
    const adapter = makeAdapter();
    adapter.configureGoalContract({ verify_command: 'true' });
    await adapter.sendMessage('goal case');
    const snapshot = adapter.getGoalRunRecord();
    expect(snapshot?.gateEvents).toEqual([]);

    // 结案后挂起 loop 还在推事件——已交出的快照不得被追写
    capturedConfigs[0].onEvent({ type: 'goal_gate', data: { gate: 0, pass: true, verdict: 'allow_finalize' } });
    expect(snapshot?.gateEvents).toEqual([]);
  });

  it('reset() clears the contract and the run record (per-case isolation)', async () => {
    const adapter = makeAdapter();
    adapter.configureGoalContract({ verify_command: 'true' });
    scriptedGoalEvents = [
      { type: 'goal_complete', data: { status: 'met', turns: 1, tokensUsed: 1 } },
    ];
    await adapter.sendMessage('goal case');
    expect(adapter.getGoalRunRecord()?.status).toBe('met');

    await adapter.reset();
    scriptedGoalEvents = [];
    await adapter.sendMessage('next case');
    expect(capturedConfigs[1].goalContract).toBeUndefined();
    expect(adapter.getGoalRunRecord()).toBeUndefined();
  });
});
