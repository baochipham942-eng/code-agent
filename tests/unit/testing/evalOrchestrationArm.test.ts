// ============================================================================
// N-EVAL-ORCHARM：编排结构（allowSwarm + spawnMaxDepth）作为实验臂维度
// ============================================================================
// 防假区分特征三条件（缺一不许进 CONSUMED_COMPARE_FIELDS）逐条钉死：
//   ① makeAgent 真读真传 —— createCompareAgent → adapter → ToolExecutor 同值
//   ② 进 effectiveArmSignature —— 只改 orchestration 的 candidate 必须放行
//   ③ 有反向变异测试 —— 摘掉任一段接线，本文件对应用例立刻转红
//
// 另外钉死「不扇出」的机制本身：spawnMaxDepth=0 时 SpawnGuard 必须真的拒，
// 而不是被 clamp 悄悄抬成 1 —— 那样开关挂了等于没挂。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSUMED_COMPARE_FIELDS,
  EVAL_DEFAULT_ALLOW_SWARM,
  resolveEffectiveEvalCompareArm,
} from '../../../src/shared/contract/evaluation';
import { SPAWN_GUARD } from '../../../src/shared/constants/agent';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../../../src/host/services/toolSearch/deferredTools';
import { EVAL_AGENT_DEFAULTS } from '../../../src/host/testing/agentAdapter';
import { getSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { assertCompareArmsDistinct } from '../../../src/host/testing/comparator/runCompare';
import {
  buildCompareArmShape,
  createCompareAgent,
} from '../../../src/host/testing/comparator/compareAgentFactory';
import { realpathSync } from 'node:fs';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';
import type { AgentEvent } from '../../../src/shared/contract';
import type { CompareConfiguration } from '../../../src/host/testing/types';

interface CapturedLoopConfig {
  goalContract?: { goal: string; allowSwarm?: boolean };
  toolExecutor: { capturedConfig?: CapturedToolExecutorConfig };
  onEvent: (event: AgentEvent) => void;
}

const capturedLoopConfigs: CapturedLoopConfig[] = [];
type CapturedToolExecutorConfig = {
  spawnMaxDepth?: number;
  restrictWritesToWorkspace?: boolean;
  runContext?: { workspaceScope?: { roots: Array<{ path: string; access: string }> } };
};
const capturedToolExecutorConfigs: CapturedToolExecutorConfig[] = [];
let scriptedEvents: AgentEvent[] = [];

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    private config: CapturedLoopConfig;
    constructor(config: CapturedLoopConfig) {
      capturedLoopConfigs.push(config);
      this.config = config;
    }
    async run(): Promise<void> {
      for (const event of scriptedEvents) this.config.onEvent(event);
    }
  },
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    capturedConfig: CapturedToolExecutorConfig;
    constructor(config: { spawnMaxDepth?: number }) {
      this.capturedConfig = config;
      capturedToolExecutorConfigs.push(config);
    }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({ SYSTEM_PROMPT: 'test system prompt' }));

vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    startSession: vi.fn(),
    endSession: vi.fn(),
    handleEvent: vi.fn(),
    createAdapter: vi.fn(() => ({})),
    systemPromptCache: undefined,
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

const BASELINE: CompareConfiguration = { name: 'baseline', model: 'model-a', provider: 'mock' };

beforeEach(() => {
  capturedLoopConfigs.length = 0;
  capturedToolExecutorConfigs.length = 0;
  scriptedEvents = [];
});

describe('条件②：orchestration 进 effectiveArmSignature', () => {
  it('orchestration 在消费表里，不在未消费表里', () => {
    expect(CONSUMED_COMPARE_FIELDS).toContain('orchestration');
  });

  it('candidate 只改 orchestration 的每一个键都算真差异（逐项放行）', () => {
    const same: CompareConfiguration = { ...BASELINE, name: 'candidate' };
    expect(() => assertCompareArmsDistinct(BASELINE, same)).toThrow();

    // 摘掉 CONSUMED_COMPARE_FIELDS 里的 'orchestration' 这两条立刻红：
    // 签名不含该维度 ⇒ 两臂签名相同 ⇒ assertCompareArmsDistinct 抛「X vs X」。
    expect(() => assertCompareArmsDistinct(BASELINE, {
      ...same, orchestration: { allowSwarm: true },
    })).not.toThrow();
    expect(() => assertCompareArmsDistinct(BASELINE, {
      ...same, orchestration: { spawnMaxDepth: 0 },
    })).not.toThrow();
    expect(() => assertCompareArmsDistinct(BASELINE, {
      ...same, orchestration: { spawnMaxDepth: 2 },
    })).not.toThrow();
  });

  it('回落语义：allowSwarm 缺省 false，spawnMaxDepth 缺省 null（跟生产默认）', () => {
    expect(resolveEffectiveEvalCompareArm(BASELINE, BASELINE).orchestration).toEqual({
      allowSwarm: EVAL_DEFAULT_ALLOW_SWARM,
      spawnMaxDepth: null,
    });
    expect(EVAL_DEFAULT_ALLOW_SWARM).toBe(false);
    // candidate 不写时继承 baseline 的值，不是又掉回默认。
    expect(resolveEffectiveEvalCompareArm(
      { name: 'candidate' },
      { ...BASELINE, orchestration: { allowSwarm: true, spawnMaxDepth: 4 } },
    ).orchestration).toEqual({ allowSwarm: true, spawnMaxDepth: 4 });
  });

  it('run stamp 的 swarm 跟随本臂生效值，不是外部另传的常量', () => {
    expect(buildCompareArmShape(BASELINE, BASELINE).swarm).toBe(false);
    expect(buildCompareArmShape(
      { name: 'candidate', orchestration: { allowSwarm: true } },
      BASELINE,
    ).swarm).toBe(true);
  });
});

describe('条件①：makeAgent 真读真传到 ToolExecutor 与 goal 契约', () => {
  it('createCompareAgent 把 orchestration 交给 adapter', () => {
    const adapter = createCompareAgent(
      { name: 'candidate', orchestration: { allowSwarm: true, spawnMaxDepth: 0 } },
      BASELINE,
      { workingDirectory: '/tmp', apiKey: 'test-key', requestPermission: async () => true },
    ) as unknown as { orchestration?: { allowSwarm?: boolean; spawnMaxDepth?: number } };
    expect(adapter.orchestration).toEqual({ allowSwarm: true, spawnMaxDepth: 0 });
  });

  it('adapter 收到 orchestration 后 ToolExecutor 拿到同值 spawnMaxDepth', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      orchestration: { spawnMaxDepth: 0 },
    });
    await adapter.sendMessage('run');
    // 摘掉 agentAdapter 里传给 ToolExecutor 的 spawnMaxDepth 这条立刻红。
    expect(capturedToolExecutorConfigs.at(-1)?.spawnMaxDepth).toBe(0);
  });

  // N-EVAL-POLICY-WRITE-BOUNDARY：写边界在 ToolExecutor 那侧有行为测试
  // （toolExecutor.workspaceWriteBoundary.test.ts），这里钉的是「评测这条路真的把它接上了」——
  // 少了这条，把 agentAdapter 里那两行摘掉，行为测试照样全绿。
  it('评测 adapter 给 ToolExecutor 开写边界，并把沙箱设成唯一可写根', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
    });
    await adapter.sendMessage('run');
    const config = capturedToolExecutorConfigs.at(-1);
    expect(config?.restrictWritesToWorkspace).toBe(true);
    const roots = config?.runContext?.workspaceScope?.roots;
    // scope 根会被 canonicalize（/tmp → /private/tmp），比对时同样取 realpath，
    // 否则这条断言在 macOS 上恒红、在 Linux 上恒绿——两边都不是在测它想测的东西。
    expect(roots?.map((root) => ({ path: root.path, access: root.access })))
      .toEqual([{ path: realpathSync('/tmp'), access: 'read_write' }]);
  });

  it('没配 orchestration 时不给 ToolExecutor 传 spawnMaxDepth（存量行为零变化）', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
    });
    await adapter.sendMessage('run');
    expect(capturedToolExecutorConfigs.at(-1)).not.toHaveProperty('spawnMaxDepth');
  });

  it('allowSwarm 走到 goal 契约；默认仍是不扇出', async () => {
    const goalContract = { goal: 'ship it', verify_command: 'true' };
    const swarmAdapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      orchestration: { allowSwarm: true },
    });
    swarmAdapter.configureGoalContract(goalContract);
    await swarmAdapter.sendMessage('run');
    expect(capturedLoopConfigs.at(-1)?.goalContract?.allowSwarm).toBe(true);

    const defaultAdapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
    });
    defaultAdapter.configureGoalContract(goalContract);
    await defaultAdapter.sendMessage('run');
    expect(capturedLoopConfigs.at(-1)?.goalContract?.allowSwarm).toBe(false);
  });
});

describe('不扇出的机制：spawnMaxDepth=0 必须真的拒', () => {
  it('SpawnGuard 对显式 0 不再 clamp 成 1，第一层子代理即超限', () => {
    const guard = getSpawnGuard();
    // 反向变异锚点：clampDepth 的下界改回 Math.max(1, …) 时这两条立刻红
    //（getMaxDepth(0) 会变成 1，checkDepth(1, 0) 会变成 true = 照样放行一层）。
    expect(guard.getMaxDepth(0)).toBe(0);
    expect(guard.checkDepth(1, 0)).toBe(false);
    // 负数同样 fail-closed 落到 0，不偷偷放行一层。
    expect(guard.getMaxDepth(-3)).toBe(0);
  });

  it('省略 / 合法值 / 超硬上限的既有语义不变', () => {
    const guard = getSpawnGuard();
    expect(guard.getMaxDepth(undefined)).toBe(SPAWN_GUARD.DEFAULT_SPAWN_DEPTH);
    expect(guard.getMaxDepth(2)).toBe(2);
    expect(guard.checkDepth(1, 2)).toBe(true);
    expect(guard.getMaxDepth(99)).toBe(SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH);
    expect(guard.getMaxDepth(Number.NaN)).toBe(SPAWN_GUARD.DEFAULT_SPAWN_DEPTH);
  });
});

describe('子代理触发次数：装好要接电', () => {
  it('adapter 按 subagent_activity(started) 计数，consume 后清零', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
    });
    adapter.configureEvaluationCase('case-1');
    scriptedEvents = [
      { type: 'subagent_activity', data: { kind: 'started', agentId: 'a1' } } as unknown as AgentEvent,
      { type: 'subagent_activity', data: { kind: 'started', agentId: 'a2' } } as unknown as AgentEvent,
      { type: 'subagent_activity', data: { kind: 'finished', agentId: 'a1' } } as unknown as AgentEvent,
    ];
    await adapter.sendMessage('run');
    expect(adapter.consumeSubagentSpawns('case-1')).toBe(2);
    expect(adapter.consumeSubagentSpawns('case-1')).toBe(0);
  });

  it('超时孤儿 loop 迟到的 started 记在它自己那题，不记到下一题头上（审计 R2-H1 同款）', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
    });
    adapter.configureEvaluationCase('case-a');
    scriptedEvents = [];
    await adapter.sendMessage('run');
    const orphanOnEvent = capturedLoopConfigs[0].onEvent;
    // testRunner 超时后切到下一题——A 题的 loop 还活着并迟到发了 started
    adapter.configureEvaluationCase('case-b');
    orphanOnEvent({ type: 'subagent_activity', data: { kind: 'started', agentId: 'late' } } as unknown as AgentEvent);
    expect(adapter.consumeSubagentSpawns('case-b')).toBe(0);
    expect(adapter.consumeSubagentSpawns('case-a')).toBe(1);
  });
});

describe('评测里子代理工具到底在不在工具面上（as-built 事实，别猜）', () => {
  it('Task / spawn_agent 不在核心工具表，只在按需加载表里登记', () => {
    // 评测默认 toolMode='deferred' ⇒ 模型第一轮看不到 Task/spawn_agent 的 schema，
    // 必须先 ToolSearch 才拉得到。spawnMaxDepth 是执行层的闸，工具面可见性是另一层，
    // 两者都影响「候选臂到底有没有机会扇出」。
    expect(CORE_TOOLS).not.toContain('Task');
    expect(CORE_TOOLS).not.toContain('spawn_agent');
    const deferredNames = DEFERRED_TOOLS_META.map((meta) => meta.name);
    expect(deferredNames).toContain('Task');
    expect(deferredNames).toContain('spawn_agent');
  });

  it('评测 adapter 的默认工具模式是 deferred', () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
    }) as unknown as { toolMode: string };
    expect(adapter.toolMode).toBe('deferred');
    // harness.toolMode='all' 时才整表下发（实验臂可用它把工具面拉平）
    const allTools = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      harness: { name: 'arm', toolMode: 'all' },
    }) as unknown as { toolMode: string };
    expect(allTools.toolMode).toBe('all');
    expect(EVAL_AGENT_DEFAULTS.skills).toEqual([]);
  });
});
