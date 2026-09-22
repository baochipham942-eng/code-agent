// N-SKILL-TRIGGER-EVAL：StandaloneAgentAdapter 的 skill 触发信号接线。
// AgentLoop 被替身掉，只留「事件进去 / 信号出来」两端——被测的是 adapter 自己：
// - skill_activated 事件按 testId 计数，consumeSkillSignals 读得出
// - 消费即清：台账不留给下一 trial（不串题）；报告侧 finally 的 ??= 兼容旧 adapter
// - skillContext 与模型真实可见集同口径（getSkillsForContext）：装了 xlsx 只见 xlsx，不存在的名字不出现
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '../../../src/shared/contract';

interface CapturedLoopConfig {
  onEvent: (event: AgentEvent) => void;
}

const capturedConfigs: CapturedLoopConfig[] = [];
let scriptedEvents: AgentEvent[] = [];

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    private config: CapturedLoopConfig;
    constructor(config: CapturedLoopConfig) {
      capturedConfigs.push(config);
      this.config = config;
    }
    async run(): Promise<void> {
      for (const event of scriptedEvents) this.config.onEvent(event);
    }
    async whenSessionEndMemoryWorkSettled(): Promise<void> { /* 替身：落盘同步完成 */ }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({ SYSTEM_PROMPT: 'test system prompt' }));
vi.mock('../../../src/host/tools/toolExecutor', () => ({ ToolExecutor: class {} }));
vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    startSession: vi.fn(), endSession: vi.fn(), handleEvent: vi.fn(), createAdapter: vi.fn(() => ({})),
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';

let workDir: string;
let dataDir: string;

beforeEach(async () => {
  capturedConfigs.length = 0;
  scriptedEvents = [];
  workDir = await mkdtemp(path.join(tmpdir(), 'adapter-skill-signals-work-'));
  dataDir = await mkdtemp(path.join(tmpdir(), 'adapter-skill-signals-data-'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function makeAdapter(skills: readonly string[]): StandaloneAgentAdapter {
  return new StandaloneAgentAdapter({
    workingDirectory: workDir,
    modelConfig: { provider: 'mock', model: 'mock-model' },
    skills,
  });
}

describe('StandaloneAgentAdapter.consumeSkillSignals', () => {
  it('skill_activated 按 testId 计数交出；skillContext 只见白名单内真实存在的 skill', async () => {
    const adapter = makeAdapter(['xlsx', 'skill-that-does-not-exist']);
    adapter.configureEvaluationCase('case-a');
    scriptedEvents = [
      { type: 'skill_activated', data: { name: 'xlsx' } },
      { type: 'skill_activated', data: { name: 'xlsx' } },
    ];
    await adapter.sendMessage('hello');

    const signals = await adapter.consumeSkillSignals('case-a');
    expect(signals.skillActivations).toEqual({ xlsx: 2 });
    expect(signals.skillContext).toContain('xlsx');
    expect(signals.skillContext).not.toContain('skill-that-does-not-exist');
    // 白名单只装 xlsx：别的 builtin skill 不进本题上下文
    expect(signals.skillContext).not.toContain('commit');
  });

  it('消费即清：consumeSkillSignals 读走即清台账，下一 trial 不会继承上一题的计数（ai-review PR#2019 Important 1）', async () => {
    const adapter = makeAdapter(['xlsx']);
    adapter.configureEvaluationCase('case-a');
    scriptedEvents = [{ type: 'skill_activated', data: { name: 'xlsx' } }];
    await adapter.sendMessage('hello');

    const first = await adapter.consumeSkillSignals('case-a');
    expect(first.skillActivations).toEqual({ xlsx: 1 });
    // 已清：再读（下一 trial 的起点）是零触发，不串题
    const second = await adapter.consumeSkillSignals('case-a');
    expect(second.skillActivations).toEqual({});
    expect(adapter.consumeSkillActivations('case-a')).toEqual({});
  });

  it('空白名单 ⇒ skillContext 为空（负样本断言的上下文守卫会 fail-loud，不真空绿）', async () => {
    const adapter = makeAdapter([]);
    adapter.configureEvaluationCase('case-a');
    await adapter.sendMessage('hello');

    const signals = await adapter.consumeSkillSignals('case-a');
    expect(signals.skillActivations).toEqual({});
    expect(signals.skillContext).toEqual([]);
  });

  it('无触发的题：计数为空但证据源在场（「记录了零次」≠「没记录」）', async () => {
    const adapter = makeAdapter(['meeting-summary']);
    adapter.configureEvaluationCase('case-a');
    await adapter.sendMessage('hello');

    const signals = await adapter.consumeSkillSignals('case-a');
    expect(signals.skillActivations).toEqual({});
    expect(signals.skillContext).toContain('meeting-summary');
  });
});
