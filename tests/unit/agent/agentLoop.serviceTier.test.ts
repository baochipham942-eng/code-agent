// N-MODELCAT-SERVICE-TIER-WIRE：service_tier 的 run 接缝接线验证——真实 AgentLoop
// 构造（mock 掉运行时模块），断言 ctx.modelConfig 上的档位裁决。这是「开关开了
// 接线也真的走到」的证据（A3 疫苗）：resolveServiceTier 单测再绿，接不上线等于没做。
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

vi.mock('../../../src/host/agent/runtime/conversationRuntime', () => ({
  ConversationRuntime: class {
    constructor(_ctx: RuntimeContext) {}
    setModules(): void {}
    async run(): Promise<void> {}
    wasInterrupted(): boolean { return false; }
  },
}));
vi.mock('../../../src/host/agent/runtime/toolExecutionEngine', () => ({
  ToolExecutionEngine: class { setModules(): void {} resetRepairGate(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/contextAssembly', () => ({
  ContextAssembly: class { setModules(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/runFinalizer', () => ({
  RunFinalizer: class { setModules(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/learningPipeline', () => ({
  LearningPipeline: class {},
}));
vi.mock('../../../src/host/agent/runtime/runtimeStatePersistence', () => ({
  loadPersistedRuntimeState: vi.fn(() => null),
}));
vi.mock('../../../src/host/agent/runtime/scaffoldProfile', () => ({
  resolveScaffoldProfileForModel: vi.fn(() => ({ tier: 'standard', auditNudgeIntervalMultiplier: 1 })),
}));
vi.mock('../../../src/host/agent/runtime/turnCostPersistence', () => ({
  createTurnCostEventHandler: vi.fn(({ onEvent }: { onEvent: (event: unknown) => void }) => onEvent),
}));
vi.mock('../../../src/host/agent/persistentRoleResolution', () => ({
  resolvePersistentRoleId: vi.fn(async () => undefined),
}));
vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => null),
}));
vi.mock('../../../src/host/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: vi.fn(),
}));
vi.mock('../../../src/host/services/roleAssets/roleProactivity', () => ({
  recordRoleParticipation: vi.fn(),
}));
vi.mock('../../../src/host/agent/capabilityGapTurnRecorder', () => ({
  recordCapabilityGapTurn: vi.fn(async () => undefined),
}));
vi.mock('../../../src/host/services/cloud/featureFlagService', () => ({
  getMaxIterations: vi.fn(() => 1),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/skills/comboRecorder', () => ({
  getComboRecorder: () => ({ startRecording: vi.fn(), markTurn: vi.fn() }),
}));
vi.mock('../../../src/host/context/autoCompressor', () => ({
  getAutoCompressor: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/telemetry/telemetryAdapter', () => ({
  createTelemetryAdapter: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/agent/metricsCollector', () => ({
  composeTelemetryAdapters: vi.fn((adapter: unknown) => adapter),
}));

import { AgentLoop } from '../../../src/host/agent/agentLoop';
import { UNATTENDED_SERVICE_TIER } from '../../../src/shared/constants';
import type { ModelConfig } from '../../../src/shared/contract';

function loopModelConfig(overrides: {
  modelConfig?: Partial<ModelConfig>;
  unattendedTurn?: boolean;
  topology?: string;
}): ModelConfig {
  const loop = new AgentLoop({
    modelConfig: { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', ...overrides.modelConfig } as ModelConfig,
    toolExecutor: { getExecutionTopology: () => overrides.topology } as never,
    messages: [],
    onEvent: vi.fn(),
    workingDirectory: '/workspace',
    sessionId: `session-service-tier-${Math.random().toString(36).slice(2)}`,
    enableHooks: false,
    ...(overrides.unattendedTurn === undefined ? {} : { unattendedTurn: overrides.unattendedTurn }),
  });
  return (loop as unknown as { ctx: RuntimeContext }).ctx.modelConfig;
}

describe('AgentLoop service_tier 接缝（N-MODELCAT-SERVICE-TIER-WIRE）', () => {
  it('unattendedTurn 的 openai run → ctx.modelConfig 挂半价档', () => {
    expect(loopModelConfig({ unattendedTurn: true }).serviceTier).toBe(UNATTENDED_SERVICE_TIER);
  });

  it('budgetScope=unattended（async_agent 拓扑，unattendedTurn 未标）→ 同样挂档', () => {
    expect(loopModelConfig({ topology: 'async_agent' }).serviceTier).toBe(UNATTENDED_SERVICE_TIER);
  });

  it('前台 openai run（无 unattendedTurn / 前台拓扑）→ 无档且字段不在场', () => {
    const resolved = loopModelConfig({});
    expect(resolved.serviceTier).toBeUndefined();
    expect('serviceTier' in resolved).toBe(false);
  });

  it('无人值守但 provider 非 openai（deepseek 走 Responses）→ 无档，请求字节不变', () => {
    const resolved = loopModelConfig({
      unattendedTurn: true,
      modelConfig: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    });
    expect('serviceTier' in resolved).toBe(false);
  });

  it('上游预置的档位被继承（parentTier 语义），前台也不丢', () => {
    expect(loopModelConfig({ modelConfig: { serviceTier: 'priority' } }).serviceTier).toBe('priority');
  });
});
