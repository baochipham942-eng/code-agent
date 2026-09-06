// ============================================================================
// SubagentExecutor 工具装配 fail-loud（N-SUBAGENT-ZEROTOOLS）
// ============================================================================
//
// 不变量（行为断言，非日志/源码表征）：
//   1. 声明了工具（请求集非空）而注册表解析为 0 ⇒ 子代理不执行任何迭代，
//      向调用方（父模型链路）返回结构化失败：failureCode: tool-unavailable +
//      missingTools 缺失清单 + error 文本含工具名。绝不静默跑完再 completed。
//   2. 真阴对照：不声明任何工具的角色（纯推理/纯总结），0 工具照常成功——
//      判据是「请求集非空而结果集为空」，不是一刀切的「0 工具」。
//   3. 声明的 MCP 工具命中 lazy（未连接）服务器时，先触发按需连接再取；
//      `mcp__<server>__*` 通配展开成具体工具名。
//   4. 部分缺失不失败，缺失清单随成功结果带回。
//
// 同 doomLoop 采用完整 runtime mock 链（见该文件头部说明），MCP 侧 mock
// '../../../src/host/mcp' 以隔离真实连接。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const toolDefinitionSnapshots: Array<Array<{ name: string }>> = [];
  const inference = vi.fn(
    async (
      _messages: Array<{ role: string; content: unknown }>,
      toolDefinitions: Array<{ name: string }>,
    ) => {
      toolDefinitionSnapshots.push(toolDefinitions);
      const response = responses.shift();
      if (!response) throw new Error('Missing mocked inference response');
      return response;
    },
  );
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
  return { responses, toolDefinitionSnapshots, inference, toolExecute, pipeline, pipelineContext };
});

const mcpState = vi.hoisted(() => ({
  ensureConnected: vi.fn(async (_serverName: string) => false),
  toolDefinitionNames: [] as string[],
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    ensureConnected: mcpState.ensureConnected,
    getToolDefinitions: () => mcpState.toolDefinitionNames.map((name) => ({
      name,
      description: `${name} from mcp`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      requiresPermission: false,
      permissionLevel: 'read',
    })),
  }),
}));

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
    cancelDescendants: vi.fn(),
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';

function makeDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    requiresPermission: false,
    permissionLevel: 'read',
  };
}

function textResponse(content: string) {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function createHarness(options: {
  availableTools: string[];
  getDefinition: (name: string) => ToolDefinition | undefined;
}) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const context = {
    sessionId: 'tool-assembly-session',
    runId: 'tool-assembly-run',
    executionAgentId: 'tool-assembly-agent',
    cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver: { getDefinition: options.getDefinition },
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
    name: 'Tool Assembly Test Agent',
    systemPrompt: 'Test tool assembly boundaries.',
    availableTools: options.availableTools,
    maxIterations: 5,
  };
  return { events, request: { prompt: 'Run the test', config, context } };
}

describe('SubagentExecutor 工具装配 fail-loud（N-SUBAGENT-ZEROTOOLS）', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.toolDefinitionSnapshots.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
    mcpState.toolDefinitionNames = [];
    mcpState.ensureConnected.mockReset();
    mcpState.ensureConnected.mockImplementation(async () => false);
  });

  it('声明了工具但一个都没装配上 ⇒ 结构化失败 + 缺失清单，不跑任何迭代', async () => {
    // 旧缺陷路径下模型会敷衍一句就 completed——这条响应在任何迭代里都不该被消费。
    mocks.responses.push(textResponse('我先列一下窗口。'));
    const { request } = createHarness({
      availableTools: ['mcp__cua-driver__*'],
      getDefinition: () => undefined,
    });

    const result = await new SubagentExecutor().execute(request);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('tool-unavailable');
    expect(result.missingTools).toEqual(['mcp__cua-driver__*']);
    expect(result.error).toContain('mcp__cua-driver__*');
    expect(result.iterations).toBe(0);
    expect(mocks.inference).not.toHaveBeenCalled();
  });

  it('内置工具名缺失同样 fail-loud，且不为此拉起任何 MCP 服务器', async () => {
    const { request } = createHarness({
      availableTools: ['NoSuchBuiltinTool'],
      getDefinition: () => undefined,
    });

    const result = await new SubagentExecutor().execute(request);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('tool-unavailable');
    expect(result.missingTools).toEqual(['NoSuchBuiltinTool']);
    expect(mcpState.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.inference).not.toHaveBeenCalled();
  });

  it('真阴对照：不声明工具的角色，0 工具照常成功（判据不许一刀切）', async () => {
    mocks.responses.push(textResponse('纯推理总结结论。'));
    const { request } = createHarness({
      availableTools: [],
      getDefinition: () => undefined,
    });

    const result = await new SubagentExecutor().execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toBe('纯推理总结结论。');
    expect(result.missingTools).toBeUndefined();
    expect(mcpState.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.inference).toHaveBeenCalledTimes(1);
  });

  it('声明的 MCP 精确名命中 lazy 服务器：先触发按需连接，再解析', async () => {
    mocks.responses.push(textResponse('lazy 工具干完了。'));
    const resolverDefs = new Map<string, ToolDefinition>();
    mcpState.ensureConnected.mockImplementation(async (serverName: string) => {
      if (serverName === 'lazy-srv') {
        // 连接成功后 server 工具进注册表——真实链路里 resolver.getDefinition
        // 会经由 getMCPClient().getToolDefinitions() 兜底解析到，这里等价模拟。
        resolverDefs.set('mcp__lazy-srv__do_work', makeDefinition('mcp__lazy-srv__do_work'));
        return true;
      }
      return false;
    });
    const { request } = createHarness({
      availableTools: ['mcp__lazy-srv__do_work'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(mcpState.ensureConnected).toHaveBeenCalledWith('lazy-srv');
    expect(result.success).toBe(true);
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name))
      .toContain('mcp__lazy-srv__do_work');
  });

  it('mcp__<server>__* 通配：先连接 server，再展开成具体工具进模型工具表', async () => {
    mocks.responses.push(textResponse('窗口列完了。'));
    mcpState.toolDefinitionNames = [
      'mcp__cua-driver__get_window_state',
      'mcp__cua-driver__click',
    ];
    mcpState.ensureConnected.mockImplementation(async () => true);
    const resolverDefs = new Map([
      ['mcp__cua-driver__get_window_state', makeDefinition('mcp__cua-driver__get_window_state')],
      ['mcp__cua-driver__click', makeDefinition('mcp__cua-driver__click')],
    ]);
    const { request } = createHarness({
      availableTools: ['mcp__cua-driver__*'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(mcpState.ensureConnected).toHaveBeenCalledWith('cua-driver');
    expect(result.success).toBe(true);
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['mcp__cua-driver__get_window_state', 'mcp__cua-driver__click']),
    );
  });

  it('部分缺失：不失败，缺失清单随成功结果带回父模型', async () => {
    mocks.responses.push(textResponse('读完了。'));
    const resolverDefs = new Map([['Read', makeDefinition('Read')]]);
    const { request } = createHarness({
      availableTools: ['Read', 'mcp__gone__nope'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(result.success).toBe(true);
    expect(result.missingTools).toEqual(['mcp__gone__nope']);
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name)).toEqual(['Read']);
  });
});
