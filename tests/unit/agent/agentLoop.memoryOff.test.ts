// N-TASK-MEMORY-OFF 写侧收口：memoryMode='off' ⇒ ctx.persistLongTermMemory=false。
// 真实 AgentLoop 构造（mock 掉运行时模块），断言 ctx 上的落值——这是「开关开了
// 接线也真的走到」的证据（A3 疫苗）。下游效果（false ⇒ recordSessionEnd /
// writeDurableFacts / runSessionEndLearning 全不跑）由 memoryIsolation.test.ts 钉。
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
import type { ModelConfig } from '../../../src/shared/contract';

function loopCtx(overrides: { memoryMode?: 'off' | 'auto'; persistLongTermMemory?: boolean }): RuntimeContext {
  const loop = new AgentLoop({
    modelConfig: { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k' } as ModelConfig,
    toolExecutor: {} as never,
    messages: [],
    onEvent: vi.fn(),
    workingDirectory: '/workspace',
    sessionId: `session-memory-off-${Math.random().toString(36).slice(2)}`,
    enableHooks: false,
    ...(overrides.memoryMode === undefined ? {} : { memoryMode: overrides.memoryMode }),
    ...(overrides.persistLongTermMemory === undefined ? {} : { persistLongTermMemory: overrides.persistLongTermMemory }),
  });
  return (loop as unknown as { ctx: RuntimeContext }).ctx;
}

describe('memoryMode=off 的写侧闸（agentLoop 收口）', () => {
  it('memoryMode=off ⇒ persistLongTermMemory 落 false', () => {
    expect(loopCtx({ memoryMode: 'off' }).persistLongTermMemory).toBe(false);
  });

  it('memoryMode=off 压倒显式 persistLongTermMemory=true（用户承诺不因配置开倒车）', () => {
    expect(loopCtx({ memoryMode: 'off', persistLongTermMemory: true }).persistLongTermMemory).toBe(false);
  });

  it('缺省档不误伤：不传 memoryMode ⇒ 记忆写侧保持默认开', () => {
    expect(loopCtx({}).persistLongTermMemory).toBe(true);
  });

  it("memoryMode='auto' 不改变显式关闭（评测隔离档仍有效）", () => {
    expect(loopCtx({ memoryMode: 'auto', persistLongTermMemory: false }).persistLongTermMemory).toBe(false);
  });

  it('ctx.memoryMode 原样透传（读侧注入跳过与工具 denylist 都看它）', () => {
    expect(loopCtx({ memoryMode: 'off' }).memoryMode).toBe('off');
  });
});
