import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const runtimeProbe = vi.hoisted(() => ({
  projectionDuringRun: undefined as RuntimeContext['turn']['modelFacingUserMessage'],
}));

vi.mock('../../../src/host/agent/runtime/conversationRuntime', () => ({
  ConversationRuntime: class {
    constructor(private readonly ctx: RuntimeContext) {}
    setModules(): void {}
    async run(): Promise<void> {
      runtimeProbe.projectionDuringRun = this.ctx.turn.modelFacingUserMessage;
    }
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

describe('AgentLoop turnSystemContext model-facing projection', () => {
  it('registers run(userMessage, displayPrompt) as a request-only projection and clears it after the run', async () => {
    const sourceMessageId = 'user-turn-system-context';
    const rawUserRequest = '执行验收';
    const executionContent = [
      '<workbench_preferences>优先使用已挂载 skill</workbench_preferences>',
      '<user_request>',
      rawUserRequest,
      '</user_request>',
    ].join('\n');
    const messages = [{
      id: sourceMessageId,
      role: 'user' as const,
      content: rawUserRequest,
      timestamp: 1,
    }];
    const loop = new AgentLoop({
      modelConfig: { provider: 'mock', model: 'test-model', apiKey: 'test' },
      toolExecutor: {} as never,
      messages,
      onEvent: vi.fn(),
      workingDirectory: '/tmp',
      enableHooks: false,
    });

    await loop.run(executionContent, rawUserRequest);

    expect(runtimeProbe.projectionDuringRun).toEqual({
      sourceMessageId,
      content: executionContent,
    });
    expect(messages[0].content).toBe(rawUserRequest);
    expect((loop as unknown as { ctx: RuntimeContext }).ctx.turn.modelFacingUserMessage).toBeUndefined();
  });
});
