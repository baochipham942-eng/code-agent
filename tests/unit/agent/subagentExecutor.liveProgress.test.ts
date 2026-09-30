import { beforeEach, describe, expect, it, vi } from 'vitest';

const DURABLE_AGENT_ID = 'subagent-bg-cost';
const ASSISTANT_TEXT = 'scanned three modules';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const state = { progressError: false, spent: 0 };
  const inference = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const noteLiveProgress = vi.fn((_agentId: string, _snapshot: { cost?: number; lastProgress?: string }) => {
    if (state.progressError) throw new Error('ledger write failed');
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
    getBudgetStatus: vi.fn(() => ({ subagentCost: state.spent })),
    getRemainingBudget: vi.fn(() => undefined),
    recordTokenUsage: vi.fn(() => { state.spent += 1.25; }),
    recordToolUsage: vi.fn(),
  };
  return { responses, state, inference, noteLiveProgress, pipeline, pipelineContext };
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
    noteLiveProgress: mocks.noteLiveProgress,
    getStatus: () => undefined,
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';

function toolResponse(name: string) {
  return {
    type: 'tool_use',
    content: '',
    toolCalls: [{ id: `${name}-1`, name, arguments: { path: 'modules.ts' } }],
    usage: { inputTokens: 3, outputTokens: 2 },
  };
}

function textResponse(content: string) {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 4, outputTokens: 5 },
  };
}

function createRequest() {
  return {
    prompt: 'Scan the modules',
    config: {
      name: 'Live Progress Agent',
      systemPrompt: 'Report what you scanned.',
      availableTools: ['Read'],
      maxIterations: 4,
    },
    context: {
      sessionId: 'live-progress-session',
      runId: 'live-progress-run',
      executionAgentId: 'executor-agent',
      cwd: '/tmp',
      modelConfig: { provider: 'test', model: 'test-model' },
      resolver: {
        getDefinition: (name: string) => ({
          name,
          description: `${name} test tool`,
          inputSchema: { type: 'object' as const },
          outputSchema: { type: 'object' as const },
          requiresPermission: false,
          permissionLevel: 'read' as const,
        }),
      },
      permission: { request: vi.fn(async () => true) },
      events: {
        emit: vi.fn(),
        backgroundDurableAgentId: DURABLE_AGENT_ID,
      },
      abortSignal: new AbortController().signal,
    },
  };
}

function queueTwoIterations(): void {
  mocks.responses.push(toolResponse('Read'), textResponse(ASSISTANT_TEXT));
}

describe('SubagentExecutor live progress (N-BGSPAWN-REPORT-COST)', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.state.progressError = false;
    mocks.state.spent = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  it('records non-empty progress and spent cost through the executor for two iterations', async () => {
    queueTwoIterations();

    const result = await new SubagentExecutor().execute(createRequest());

    expect(result).toMatchObject({
      success: true,
      output: ASSISTANT_TEXT,
      iterations: 2,
      toolsUsed: ['Read'],
    });
    expect(mocks.inference).toHaveBeenCalledTimes(2);
    expect(mocks.noteLiveProgress).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.noteLiveProgress.mock.calls;
    expect(first?.[0]).toBe(DURABLE_AGENT_ID);
    expect(first?.[1]).toMatchObject({
      cost: 1.25,
      iterations: 1,
      toolCalls: 1,
      lastProgress: 'Read',
    });
    expect(second?.[0]).toBe(DURABLE_AGENT_ID);
    expect(second?.[1]).toMatchObject({
      cost: 2.5,
      iterations: 2,
      toolCalls: 1,
      lastProgress: ASSISTANT_TEXT,
    });
    const recorded = second?.[1];
    expect(recorded?.lastProgress && recorded.lastProgress.length > 0).toBe(true);
    expect(recorded?.cost ?? 0).toBeGreaterThan(0);
  });

  it('keeps running and logs a warn when live progress recording throws', async () => {
    mocks.state.progressError = true;
    queueTwoIterations();
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });

    try {
      const result = await new SubagentExecutor().execute(createRequest());

      expect(result).toMatchObject({ success: true, output: ASSISTANT_TEXT, iterations: 2 });
      expect(mocks.noteLiveProgress).toHaveBeenCalledTimes(2);
      expect(logged.some((line) => line.includes('live progress was not recorded: ledger write failed'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
