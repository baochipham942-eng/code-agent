// ============================================================================
// SubagentExecutor abort 出口的 endRun 终态（Rework r2 回归钉子）
// ============================================================================
//
// 不变量：循环头 abort 收口（handleSubagentAbort）在 executeInternal 的 try 内
// 被 `return await`——finally 里 `endRun(terminal.status, terminal.error)` 必须在
// flush 完成并把 terminal 置为 'cancelled' 之后才跑。若漏掉 await，finally 会在
// handleSubagentAbort 的第一个 await 处同步抢跑，endRun 收到的是初始值
// ('failed', undefined)，所有超时/取消的子代理 run 都被记成 failed。
//
// 断言落在事件口（events.emit 的 subagent_run_end）——turnObservability.endRun
// 前转的正是这个口，比 spy 内部对象更贴消费方视角。
// mock 链沿 subagentExecutor.contextPublishing.test.ts，仅取消生命周期改为
// 「进循环前已按 reason='timeout' 中止」。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const inference = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const flushCancellation = vi.fn(async () => {});
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
  return { responses, inference, flushCancellation, pipeline, pipelineContext };
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
  flushSubagentCancellation: mocks.flushCancellation,
  // 进入循环前就已按 'timeout' 中止——循环头 abort 收口立即触发。
  createSubagentCancellationLifecycle: () => {
    const controller = new AbortController();
    controller.abort('timeout');
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

vi.mock('../../../src/host/context/subagentContextStore', () => ({
  getSubagentContextStore: () => ({ upsert: vi.fn(), list: () => [] }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';

describe('SubagentExecutor abort tail endRun terminal state', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_MODEL_ENGINE;
  });

  it("cancelled run ends observability as 'cancelled' with the timeout message, not 'failed'", async () => {
    const events = { emit: vi.fn() };
    const result = await new SubagentExecutor().execute({
      prompt: '会被超时打断的任务',
      config: {
        name: 'abort-run-agent',
        systemPrompt: '你是一个测试用子代理。',
        availableTools: [],
      },
      context: {
        sessionId: 'abort-endrun-session',
        cwd: '/tmp/work',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: () => undefined },
        permission: { request: async () => false },
        events,
        abortSignal: new AbortController().signal,
      },
    });

    // 返回值两版（漏 await / 补 await）一致：失败 + timeout 码
    expect(result).toMatchObject({ success: false, cancellationReason: 'timeout' });
    expect(mocks.flushCancellation).toHaveBeenCalledTimes(1);

    // 分野在这里：endRun 必须读到 flush 之后的 terminal（'cancelled' + 超时文案），
    // 而不是初始盒 ('failed', undefined)。
    const runEndEvents = events.emit.mock.calls.filter(([name]) => name === 'subagent_run_end');
    expect(runEndEvents, '应恰好发射一次 subagent_run_end').toHaveLength(1);
    expect(runEndEvents[0][1]).toMatchObject({ status: 'cancelled' });
    expect((runEndEvents[0][1] as { error?: string }).error).toContain('执行超时');
  });
});
