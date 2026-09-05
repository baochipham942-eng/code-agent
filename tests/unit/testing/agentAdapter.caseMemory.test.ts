// N-EVAL-MEMORY：StandaloneAgentAdapter 的 case 级记忆接线。
// AgentLoop 被替身掉，只留「配置进去 / 事件出来」两端 —— 被测的是 adapter 自己：
// - 声明了记忆的 case，这一题的 loop 配置里 persistLongTermMemory / includeRecentConversations 都开
// - 没声明的 case 维持评测默认（两向都关）
// - memory_injected 的 entries 去重累加进落账；memory_written 累加成写入次数
// - 只有开了记忆的题才快照记忆目录（没开的题快照缺席 ⇒ memory_written 判定 fail-loud）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '../../../src/shared/contract';

interface CapturedLoopConfig {
  persistLongTermMemory?: boolean;
  includeRecentConversations?: boolean;
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

function makeAdapter(): StandaloneAgentAdapter {
  return new StandaloneAgentAdapter({
    workingDirectory: '/tmp',
    modelConfig: { provider: 'mock', model: 'mock-model' },
  });
}

let dataDir: string;

beforeEach(async () => {
  capturedConfigs.length = 0;
  scriptedEvents = [];
  dataDir = await mkdtemp(path.join(tmpdir(), 'adapter-case-memory-'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe('StandaloneAgentAdapter case-level memory', () => {
  it('没声明记忆的 case 维持评测默认：两向都关', async () => {
    const adapter = makeAdapter();
    await adapter.configureCaseMemory(undefined);
    await adapter.sendMessage('hello');

    expect(capturedConfigs[0]).toMatchObject({
      persistLongTermMemory: false,
      includeRecentConversations: false,
    });
  });

  it('声明了记忆的 case，这一题两向都开', async () => {
    const adapter = makeAdapter();
    await adapter.configureCaseMemory({ enabled: true });
    await adapter.sendMessage('hello');

    expect(capturedConfigs[0]).toMatchObject({
      persistLongTermMemory: true,
      includeRecentConversations: true,
    });
  });

  it('下一题不带记忆时闸自己关回去（不串题）', async () => {
    const adapter = makeAdapter();
    await adapter.configureCaseMemory({ enabled: true });
    await adapter.sendMessage('hello');
    await adapter.configureCaseMemory(undefined);
    await adapter.sendMessage('hello again');

    expect(capturedConfigs[0].persistLongTermMemory).toBe(true);
    expect(capturedConfigs[1].persistLongTermMemory).toBe(false);
  });

  it('seed 在 configureCaseMemory 那一刻就落进本题记忆目录', async () => {
    const adapter = makeAdapter();
    await adapter.configureCaseMemory({
      enabled: true,
      seed: { files: [{ name: 'mem-orchid.md', content: '内部项目 Orchid 的主视觉色是 #2F6D4F。' }] },
    });

    const { readFile } = await import('node:fs/promises');
    const index = await readFile(path.join(dataDir, 'memory', 'INDEX.md'), 'utf-8');
    expect(index).toContain('mem-orchid.md');
  });

  it('memory_injected 的 entries 去重累加，memory_written 累加成写入次数', async () => {
    const adapter = makeAdapter();
    adapter.configureEvaluationCase('case-a');
    await adapter.configureCaseMemory({ enabled: true });
    scriptedEvents = [
      { type: 'memory_injected', data: { id: 'memory_index', entries: ['mem-orchid.md'] } },
      { type: 'memory_injected', data: { id: 'memory_index', entries: ['mem-orchid.md', 'mem-halberd.md'] } },
      { type: 'memory_written', data: { files: ['mem-a.md'], written: 1 } },
      { type: 'memory_written', data: { files: ['mem-b.md', 'mem-c.md'], written: 2 } },
    ];
    await adapter.sendMessage('hello');

    const signals = adapter.consumeMemorySignals('case-a');
    expect(signals.memoryRecall).toEqual({
      injections: 2,
      entries: ['mem-orchid.md', 'mem-halberd.md'],
    });
    expect(signals.memoryWrites).toBe(3);
    // 读走即清空，下一题不会继承上一题的落账
    expect(adapter.consumeMemorySignals('case-a').memoryRecall).toBeUndefined();
  });

  it('把注入/写入信号转发给评测信号回调（桥靠它收）', async () => {
    const signals: unknown[] = [];
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      onEvaluationSignal: (signal) => signals.push(signal),
    });
    adapter.configureEvaluationCase('case-a');
    await adapter.configureCaseMemory({ enabled: true });
    scriptedEvents = [
      { type: 'memory_injected', data: { id: 'memory_index', entries: ['mem-orchid.md'] } },
      { type: 'memory_written', data: { files: ['mem-a.md'], written: 1 } },
    ];
    await adapter.sendMessage('hello');

    expect(signals).toEqual([
      { type: 'memory_injected', testId: 'case-a', id: 'memory_index', entries: ['mem-orchid.md'] },
      { type: 'memory_written', testId: 'case-a', files: ['mem-a.md'], written: 1 },
    ]);
  });

  it('开了记忆才快照记忆目录；没开的题快照缺席（判定据此 fail-loud）', async () => {
    await mkdir(path.join(dataDir, 'memory'), { recursive: true });
    await writeFile(
      path.join(dataDir, 'memory', 'mem-beacon.md'),
      '---\nname: mem-beacon\ndescription: d\ntype: reference\n---\n\n内部项目 Beacon 的周会在每周二。\n',
      'utf-8',
    );

    const withMemory = makeAdapter();
    withMemory.configureEvaluationCase('case-a');
    await withMemory.configureCaseMemory({ enabled: true });
    await withMemory.sendMessage('hello');
    const snapshot = withMemory.consumeMemorySignals('case-a').memorySnapshot;
    expect(snapshot?.map((file) => file.name)).toContain('mem-beacon.md');
    expect(snapshot?.find((file) => file.name === 'mem-beacon.md')?.content).toContain('Beacon');

    const withoutMemory = makeAdapter();
    withoutMemory.configureEvaluationCase('case-b');
    await withoutMemory.configureCaseMemory(undefined);
    await withoutMemory.sendMessage('hello');
    expect(withoutMemory.consumeMemorySignals('case-b').memorySnapshot).toBeUndefined();
  });
});
