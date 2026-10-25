// ============================================================================
// N-MODELCAT-SERVICE-TIER-COST r2：子代理记账不丢响应实报档位。
// ----------------------------------------------------------------------------
// 无人值守 run（openai+responses）的子代理继承 flex 档发起请求，响应 usage 带
// serviceTier='flex'；但 SubagentExecutor 重建 TokenUsage 时只取 input/output，
// 档位被丢——子代理开销按标准价记账，getCurrentCost 虚高约 2 倍，设了 maxBudget
// 的 run 会在真实花费未到线时被提前告警/拦停。这里跑真实 executor（mock 掉
// modelRouter/pipeline），断言 pipeline.recordTokenUsage 收到的 TokenUsage 带档。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const inference = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const pipelineContext = {
    agentId: 'pipeline-agent',
    permissionConfig: { blockedCommands: [] as string[] },
  };
  const pipeline = {
    createContext: vi.fn(() => pipelineContext),
    checkBudget: vi.fn(() => ({ allowed: true, warnings: [] as string[] })),
    checkToolExecution: vi.fn(() => ({ allowed: true })),
    completeContext: vi.fn(),
    getBudgetStatus: vi.fn(() => ({ subagentCost: 0 })),
    getRemainingBudget: vi.fn(() => undefined),
    recordTokenUsage: vi.fn(),
    recordToolUsage: vi.fn(),
  };
  return { responses, inference, pipeline, pipelineContext };
});

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    inference = mocks.inference;
  },
  PROVIDER_REGISTRY: {
    test: { models: [{ id: 'test-model', supportsTool: true }] },
  },
}));

vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({
  aiSdkSupportsProvider: () => false,
  inferenceViaAiSdk: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentPipeline', () => ({
  getSubagentPipeline: () => mocks.pipeline,
}));

vi.mock('../../../src/host/agent/subagentToolRuntime', () => ({
  createSubagentToolRuntime: () => ({
    executor: { execute: vi.fn(async () => ({ success: true, output: 'Read partial output' })) },
    policy: {},
  }),
}));

vi.mock('../../../src/host/agent/agentTask', () => ({
  AgentTask: class {
    id: string;
    appendTranscript = vi.fn();
    stop = vi.fn();
    fail = vi.fn();

    constructor(id: string) {
      this.id = id;
    }
  },
}));

vi.mock('../../../src/host/agent/subagentLifecycleHooks', () => ({
  startSubagentLifecycle: ({ context }: { context: { sessionId: string } }) => context.sessionId,
}));

vi.mock('../../../src/host/agent/subagentExecutionTracing', () => ({
  runSubagentExecutionWithTrace: (
    _request: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}));

vi.mock('../../../src/host/agent/subagentExecutionRouter', () => ({
  routeExternalSubagentExecution: () => null,
}));

vi.mock('../../../src/host/testing/e2e/subagentE2ELocalExecutor', () => ({
  shouldUseE2ELocalSubagentExecutor: () => false,
  executeE2ELocalSubagent: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentFirstRunPreset', () => ({
  resolveSubagentPreset: async (preset: unknown) => preset,
}));

vi.mock('../../../src/host/agent/subagentProtocolContext', () => ({
  normalizeSubagentModelContext: (context: unknown) => context,
  resolveSubagentParentContext: () => ({ availableTools: [] }),
}));

vi.mock('../../../src/host/agent/childContext', () => ({
  buildChildContext: (child: { allowedTools: string[] }) => ({
    toolPool: child.allowedTools,
    permissions: {
      deny: [],
      blockedCommands: [],
      effectiveMode: 'default',
    },
  }),
}));

vi.mock('../../../src/host/agent/subagentExecutorCancellation', () => ({
  getChildSubagentExecutionTimeout: () => 60_000,
  getSubagentIdleTimeout: () => 30_000,
  createSubagentCancellationLifecycle: () => {
    const controller = new AbortController();
    return {
      effectiveController: controller,
      effectiveSignal: controller.signal,
      cleanupTimer: vi.fn(),
      markProgress: vi.fn(),
      markRequestStart: vi.fn(),
      markRequestEnd: vi.fn(),
      markToolStart: vi.fn(),
      markToolEnd: vi.fn(),
      stopIdleWatchdog: vi.fn(),
    };
  },
}));

vi.mock('../../../src/host/context/subagentContextStore', () => ({
  getSubagentContextStore: () => ({ upsert: vi.fn() }),
}));

vi.mock('../../../src/host/context/contextInterventionState', () => ({
  getContextInterventionState: () => ({ getEffectiveSnapshot: () => ({}) }),
}));

vi.mock('../../../src/host/context/contextInterventionHelpers', () => ({
  applyInterventionsToMessages: (messages: unknown) => messages,
}));

vi.mock('../../../src/host/agent/subagentCompaction', () => ({
  compactSubagentMessages: () => false,
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ recordDetachedTurn: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ permissions: { inheritance: 'strict-inherit' } }),
  }),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
  adoptOrphanTasks: vi.fn(),
}));

vi.mock('../../../src/host/services/roleAssets', () => ({
  buildRoleContextBlock: vi.fn(),
  runRoleWriteBack: vi.fn(),
  recordRoleParticipation: vi.fn(),
  applyRoleBoundaryToSubagentRequest: vi.fn((request: unknown) => request),
}));

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    drainMessages: () => [],
    peekMessages: () => [],
    cancelDescendants: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/backgroundSubagentRegistry', () => ({
  getBackgroundSubagentRegistry: () => ({
    noteLiveProgress: vi.fn(),
    getStatus: () => undefined,
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { UNATTENDED_SERVICE_TIER } from '../../../src/shared/constants';

function textResponse(content: string, usage?: Record<string, unknown>) {
  return {
    type: 'text',
    content,
    usage: usage ?? { inputTokens: 4, outputTokens: 5 },
  };
}

function createRequest() {
  return {
    prompt: 'Scan the modules',
    config: {
      name: 'Tiered Cost Agent',
      systemPrompt: 'Report what you scanned.',
      availableTools: [],
    },
    context: {
      sessionId: 'service-tier-session',
      cwd: '/tmp',
      modelConfig: { provider: 'test', model: 'test-model' },
      resolver: { getDefinition: () => undefined },
      permission: { request: vi.fn(async () => false) },
      events: { emit: vi.fn() },
      abortSignal: new AbortController().signal,
    },
  };
}

describe('SubagentExecutor token usage keeps the response-reported service tier (r2)', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  it('response usage 带 service_tier=flex → pipeline.recordTokenUsage 的 TokenUsage 带档', async () => {
    mocks.responses.push(textResponse('flex 子代理的回答', {
      inputTokens: 9,
      outputTokens: 6,
      serviceTier: UNATTENDED_SERVICE_TIER,
    }));

    const result = await new SubagentExecutor().execute(createRequest());

    expect(result).toMatchObject({ success: true, output: 'flex 子代理的回答' });
    expect(mocks.pipeline.recordTokenUsage).toHaveBeenCalledTimes(1);
    const [, recorded] = mocks.pipeline.recordTokenUsage.mock.calls[0];
    // 带档透传：预算侧据此按 SERVICE_TIER_COST_MULTIPLIER 折价（flex = 0.5x）
    expect(recorded).toMatchObject({
      inputTokens: 9,
      outputTokens: 6,
      serviceTier: UNATTENDED_SERVICE_TIER,
    });
  });

  it('response usage 无档（standard）→ TokenUsage 不带 serviceTier 字段（缺席 = 标准价，字节不变）', async () => {
    mocks.responses.push(textResponse('标准价子代理的回答'));

    const result = await new SubagentExecutor().execute(createRequest());

    expect(result).toMatchObject({ success: true, output: '标准价子代理的回答' });
    expect(mocks.pipeline.recordTokenUsage).toHaveBeenCalledTimes(1);
    const [, recorded] = mocks.pipeline.recordTokenUsage.mock.calls[0];
    expect(recorded).toMatchObject({ inputTokens: 4, outputTokens: 5 });
    expect('serviceTier' in recorded).toBe(false);
  });
});
