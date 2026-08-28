import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const inferenceMessages: Array<Array<{ role: string; content: unknown }>> = [];
  const inference = vi.fn(async (messages: Array<{ role: string; content: unknown }>) => {
    inferenceMessages.push(messages);
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const toolExecute = vi.fn(async (name: string) => ({
    success: true,
    output: `${name} partial output`,
  }));
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
  return { responses, inferenceMessages, inference, toolExecute, pipeline, pipelineContext };
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
    executor: { execute: mocks.toolExecute },
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
  // K2：子代理分流前统一收窄 request；本用例不测边界，透传即可（不许在这里模拟收窄，
  // 否则 doomLoop 的断言会被无关的工具表变化带偏）。
  applyRoleBoundaryToSubagentRequest: vi.fn((request: unknown) => request),
}));

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    drainMessages: () => [],
    cancelDescendants: vi.fn(),
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';

type CapturedEvent = { type: string; data: Record<string, unknown> };

function toolResponse(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  return {
    type: 'tool_use',
    content: '',
    toolCalls: calls,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function textResponse(content: string) {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function createHarness() {
  const events: CapturedEvent[] = [];
  const resolver = {
    getDefinition: (name: string) => ({
      name,
      description: `${name} test tool`,
      inputSchema: { type: 'object' as const },
      outputSchema: { type: 'object' as const },
      requiresPermission: false,
      permissionLevel: 'read' as const,
    }),
  };
  const context = {
    sessionId: 'doom-session',
    runId: 'doom-run',
    executionAgentId: 'doom-agent',
    cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver,
    permission: { request: vi.fn(async () => true) },
    events: {
      emit: (type: string, data: unknown) => events.push({
        type,
        data: data as Record<string, unknown>,
      }),
    },
    abortSignal: new AbortController().signal,
  };
  const config = {
    name: 'Doom Test Agent',
    systemPrompt: 'Test the background loop.',
    availableTools: ['Read', 'Grep'],
    maxIterations: 10,
  };
  return { events, request: { prompt: 'Run the test', config, context } };
}

describe('SubagentExecutor doom-loop guard', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.inferenceMessages.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  it('injects the same-call nudge, then cancels the run while preserving partial results', async () => {
    for (let iteration = 1; iteration <= 4; iteration++) {
      mocks.responses.push(toolResponse([{
        id: `read-${iteration}`,
        name: 'Read',
        arguments: { path: 'same.ts' },
      }]));
    }
    const { events, request } = createHarness();

    const result = await new SubagentExecutor().execute(request);

    expect(mocks.inference).toHaveBeenCalledTimes(4);
    expect(mocks.toolExecute).toHaveBeenCalledTimes(3);
    expect(mocks.inferenceMessages[3]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('<doom-loop-guard>'),
      }),
    ]));
    expect(result).toMatchObject({
      success: false,
      output: '',
      iterations: 4,
      toolsUsed: ['Read'],
      error: expect.stringContaining('doom-loop guard'),
      contextSnapshot: {
        tools: ['Read'],
      },
    });
    expect(result.contextSnapshot?.previews).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentPreview: expect.stringContaining('Read partial output') }),
    ]));
    expect(events.filter((event) => event.type === 'subagent_run_end')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    ]);
  });

  it('nudges an identical multi-tool step without cancelling it', async () => {
    for (let iteration = 1; iteration <= 3; iteration++) {
      mocks.responses.push(toolResponse([
        { id: `read-${iteration}`, name: 'Read', arguments: { path: 'same.ts' } },
        { id: `grep-${iteration}`, name: 'Grep', arguments: { pattern: 'same' } },
      ]));
    }
    mocks.responses.push(textResponse('Recovered after the repeated-step nudge.'));
    const { events, request } = createHarness();

    const result = await new SubagentExecutor().execute(request);

    expect(result).toMatchObject({
      success: true,
      output: 'Recovered after the repeated-step nudge.',
      iterations: 4,
    });
    expect(mocks.toolExecute).toHaveBeenCalledTimes(6);
    expect(mocks.inferenceMessages[3]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('steps have been identical'),
      }),
    ]));
    expect(events.find((event) => event.type === 'subagent_run_end')?.data.status).toBe('completed');
  });

  it('continues empty output to the shared limit and then cancels', async () => {
    mocks.responses.push(
      textResponse(''),
      textResponse('   '),
      textResponse(''),
      textResponse(''),
    );
    const { events, request } = createHarness();

    const result = await new SubagentExecutor().execute(request);

    expect(mocks.inference).toHaveBeenCalledTimes(4);
    expect(mocks.inferenceMessages[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('no usable answer'),
      }),
    ]));
    expect(result).toMatchObject({
      success: false,
      output: '',
      iterations: 4,
      error: expect.stringContaining('empty model output'),
    });
    expect(events.find((event) => event.type === 'subagent_run_end')?.data.status).toBe('cancelled');
  });
});
