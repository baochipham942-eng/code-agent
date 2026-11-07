// N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE：子代理（文字前台委派的常见路径）里 MCP 权限范围不足的失败也发 connector_required 卡
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DURABLE_AGENT_ID = 'subagent-bg-scope';
const ASSISTANT_TEXT = 'could not edit the page';

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
  const toolResult = { current: { success: true, output: 'ok' } as Record<string, unknown> };
  return { responses, state, inference, noteLiveProgress, pipeline, pipelineContext, toolResult };
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
    executor: { execute: vi.fn(async () => mocks.toolResult.current) },
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
      name: 'Scope Card Agent',
      systemPrompt: 'Report what you scanned.',
      availableTools: ['Read'],
      maxIterations: 4,
    },
    context: {
      sessionId: 'scope-card-session',
      runId: 'scope-card-run',
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

describe('SubagentExecutor insufficient_scope → connector_required', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  const emitted = (request: ReturnType<typeof createRequest>) =>
    (request.context.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(([event]) => event === 'connector_required');

  it('emits one card for a failing MCP tool call carrying the insufficient-scope marker', async () => {
    mocks.toolResult.current = {
      success: false,
      error: 'insufficient_scope: ...',
      metadata: { mcpInsufficientScope: { requiredScope: 'write' }, server: 'notion' },
    };
    mocks.responses.push(toolResponse('Read'), textResponse(ASSISTANT_TEXT));
    const request = createRequest();
    await new SubagentExecutor().execute(request);
    expect(emitted(request)).toEqual([[
      'connector_required',
      { connectors: [{ id: 'notion', source: 'selected', reason: 'insufficient_scope', requiredScope: 'write' }] },
    ]]);
  });

  it('does not emit for an ordinary tool failure', async () => {
    mocks.toolResult.current = { success: false, error: 'boom' };
    mocks.responses.push(toolResponse('Read'), textResponse(ASSISTANT_TEXT));
    const request = createRequest();
    await new SubagentExecutor().execute(request);
    expect(emitted(request)).toEqual([]);
  });
});
