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

// 取消组测试要能从用例侧触发 effectiveSignal（父 abort / 内部 timeout 的桥接产物），
// 让 lifecycle mock 的 controller 从这里暴露。
const cancellationState = vi.hoisted(() => ({
  controller: new AbortController(),
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
  flushSubagentCancellation: vi.fn(async () => {}),
  createSubagentCancellationLifecycle: () => {
    cancellationState.controller = new AbortController();
    return {
      effectiveController: cancellationState.controller,
      effectiveSignal: cancellationState.controller.signal,
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

// 取消收口路径的副作用（磁盘路径 / patch 抢救）mock 掉——flush 本体在
// subagentExecutorCancellation 里已被 mock，这里兜 turnTrace 的 getPath。

vi.mock('../../../src/host/platform/appPaths', () => ({
  getUserDataPath: () => '/tmp',
  // TurnTraceRecorder（executeInternal 经由 turnObservability 使用）也走 getPath
  getPath: () => '/tmp',
}));

vi.mock('../../../src/host/services/checkpoint/taskPatchService', () => ({
  captureWorkspacePatch: vi.fn(async () => undefined),
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
import { MCPClient } from '../../../src/host/mcp/mcpClient';

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

/**
 * 用真 MCPClient.ensureConnected 驱动 mcp mock：私有字段预置 lazy server（stdio 形状），
 * connect 交由用例 spy 控制（挂起 / 成功）。这样「signal 只中断本次等待、连接继续」
 * 的 race 语义是被真实现咬住的，而不是 mock 复刻。
 */
/** 受控真 ensureConnected 客户端（不能与 MCPClient 交叉——private 字段会推成 never）。 */
type RealEnsureConnectedClient = {
  clients: Map<string, unknown>;
  inProcessServers: Map<string, unknown>;
  serverConfigs: Map<string, unknown>;
  serverStates: Map<string, { status: string }>;
  connectingServers: Map<string, Promise<void>>;
  connect(config: { name: string }): Promise<void>;
  ensureConnected(serverName: string, signal?: AbortSignal): Promise<boolean>;
};

function setupRealEnsureConnected(serverNames: string[]): {
  client: RealEnsureConnectedClient;
  connectSpy: ReturnType<typeof vi.spyOn>;
} {
  const client = Object.create(MCPClient.prototype) as RealEnsureConnectedClient;
  Object.assign(client, {
    clients: new Map(),
    inProcessServers: new Map(),
    serverConfigs: new Map(serverNames.map((name) => [
      name,
      { name, command: 'sleep', args: ['60'], enabled: true, lazyLoad: true },
    ])),
    serverStates: new Map(serverNames.map((name) => [name, { status: 'lazy' }])),
    connectingServers: new Map(),
  });
  const connectSpy = vi.spyOn(client, 'connect');
  mcpState.ensureConnected.mockImplementation(
    async (serverName: string, signal?: AbortSignal) => client.ensureConnected(serverName, signal),
  );
  return { client, connectSpy };
}

function createHarness(options: {
  availableTools: string[];
  getDefinition: (name: string) => ToolDefinition | undefined;
  allowedToolNames?: readonly string[];
  deniedToolNames?: readonly string[];
  toolScope?: { allowedMcpServerIds?: string[] };
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
    ...(options.allowedToolNames ? { allowedToolNames: options.allowedToolNames } : {}),
    ...(options.deniedToolNames ? { deniedToolNames: options.deniedToolNames } : {}),
    ...(options.toolScope ? { toolScope: options.toolScope } : {}),
  };
  const config = {
    name: 'Tool Assembly Test Agent',
    systemPrompt: 'Test tool assembly boundaries.',
    availableTools: options.availableTools,
    maxIterations: 5,
  };
  return { events, request: { prompt: 'Run the test', config, context } };
}

// 两个 describe 共用的清理（顶层 beforeEach，避免新增取消组串到上一组的状态）
beforeEach(() => {
  mocks.responses.length = 0;
  mocks.toolDefinitionSnapshots.length = 0;
  vi.clearAllMocks();
  process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  mcpState.toolDefinitionNames = [];
  mcpState.ensureConnected.mockReset();
  mcpState.ensureConnected.mockImplementation(async () => false);
});

describe('SubagentExecutor 工具装配 fail-loud（N-SUBAGENT-ZEROTOOLS）', () => {

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

    expect(mcpState.ensureConnected).toHaveBeenCalledWith('lazy-srv', expect.any(AbortSignal));
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

    expect(mcpState.ensureConnected).toHaveBeenCalledWith('cua-driver', expect.any(AbortSignal));
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

describe('装配等待取消接线（N-SUBAGENT-ZEROTOOLS 返修 Important 1）', () => {
  it('连接进行中触发取消 ⇒ 装配立即收口为取消，且不再启动后续服务器连接', async () => {
    // 连接永不 settle：旧形状（装配链不接收 signal）会永远挂在这条等待上。
    const { connectSpy } = setupRealEnsureConnected(['slow-one', 'slow-two']);
    connectSpy.mockImplementation(() => new Promise<void>(() => {}));
    const { request } = createHarness({
      availableTools: ['mcp__slow-one__x', 'mcp__slow-two__y'],
      getDefinition: () => undefined,
    });

    const executing = new SubagentExecutor().execute(request);
    await vi.waitFor(() => expect(connectSpy).toHaveBeenCalledTimes(1));
    cancellationState.controller.abort('parent-cancel');

    const result = await executing;

    expect(result.success).toBe(false);
    // 取消打断的装配按取消收口，不误报 tool-unavailable
    expect(result.cancellationReason).toBe('parent-cancel');
    expect(result.failureCode).not.toBe('tool-unavailable');
    expect(connectSpy).toHaveBeenCalledTimes(1); // slow-two 未被发起
    expect(mocks.inference).not.toHaveBeenCalled();
  });

  it('真阴：未取消时两个 lazy server 顺序连完，工具照常装配', async () => {
    mocks.responses.push(textResponse('两个服务器都连上了。'));
    const resolverDefs = new Map<string, ToolDefinition>();
    const { client, connectSpy } = setupRealEnsureConnected(['alpha', 'beta']);
    connectSpy.mockImplementation(async (config: { name: string }) => {
      // 连接成功：server 进共享注册表，其工具可被 resolver 解析到（等价模拟）
      client.clients.set(config.name, { fake: true });
      resolverDefs.set(`mcp__${config.name}__work`, makeDefinition(`mcp__${config.name}__work`));
    });
    const { request } = createHarness({
      availableTools: ['mcp__alpha__work', 'mcp__beta__work'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(result.success).toBe(true);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(result.missingTools).toBeUndefined();
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name).sort()).toEqual(
      ['mcp__alpha__work', 'mcp__beta__work'],
    );
  });

  it('ensureConnected 不响应 signal 时，装配循环自身也在每次连接前停下（不发起后续连接）', async () => {
    const seen: string[] = [];
    mcpState.ensureConnected.mockImplementation(async (serverName: string) => {
      seen.push(serverName);
      if (serverName === 'srv-a') cancellationState.controller.abort('parent-cancel');
      return false; // 模拟旧形状：不接收 signal，也不响应取消
    });
    const { request } = createHarness({
      availableTools: ['mcp__srv-a__x', 'mcp__srv-b__y'],
      getDefinition: () => undefined,
    });

    const result = await new SubagentExecutor().execute(request);

    expect(seen).toEqual(['srv-a']); // 循环级检查在 srv-b 连接前停下
    expect(result.success).toBe(false);
    expect(result.cancellationReason).toBe('parent-cancel');
    expect(result.failureCode).not.toBe('tool-unavailable');
    expect(mocks.inference).not.toHaveBeenCalled();
  });
});

describe('装配期 MCP 通配连接服从 run 策略（N-SUBAGENT-ZEROTOOLS R3）', () => {
  it('声明 Read + mcp__slow__*、run 只允许 Read ⇒ 不连接被排除的 MCP，装配直接完成', async () => {
    mocks.responses.push(textResponse('读完了。'));
    const { connectSpy } = setupRealEnsureConnected(['slow']);
    // 若过滤提前被摘掉，这条 hanging connect 会让装配卡死——断言「没等待」。
    connectSpy.mockImplementation(() => new Promise<void>(() => {}));
    const resolverDefs = new Map([['Read', makeDefinition('Read')]]);
    const { request } = createHarness({
      availableTools: ['Read', 'mcp__slow__*'],
      allowedToolNames: ['Read'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(mcpState.ensureConnected).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.missingTools).toBeUndefined();
    expect(mocks.inference).toHaveBeenCalledTimes(1);
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name)).toEqual(['Read']);
  });

  it('真阴：run 策略允许该 MCP 工具时，照常连接并展开', async () => {
    mocks.responses.push(textResponse('读完并连上了。'));
    mcpState.toolDefinitionNames = ['mcp__slow__work'];
    mcpState.ensureConnected.mockImplementation(async () => true);
    const resolverDefs = new Map([
      ['Read', makeDefinition('Read')],
      ['mcp__slow__work', makeDefinition('mcp__slow__work')],
    ]);
    const { request } = createHarness({
      availableTools: ['Read', 'mcp__slow__*'],
      allowedToolNames: ['Read', 'mcp__slow__work'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(mcpState.ensureConnected).toHaveBeenCalledWith('slow', expect.any(AbortSignal));
    expect(result.success).toBe(true);
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name).sort()).toEqual(
      ['Read', 'mcp__slow__work'],
    );
  });
});

describe('策略允许的通配装配失败不许静默成功（N-SUBAGENT-ZEROTOOLS R4 回归）', () => {
  // R3 的 server 粒度预判认得「声明通配 + 白名单精确名」是同一个 server ⇒ 照常连接；
  // 连接失败后旧代码把原样保留的通配名也丢进精确白名单过滤 ⇒ 请求集与缺失清单双空
  // ⇒ 零工具判据失明 ⇒ 子代理零工具跑完还报成功。这里钉死父模型收到的失败不变量。
  it('🔴 声明 mcp__slow__* + 白名单允许精确名 mcp__slow__work + 连接失败 ⇒ 结构化失败 + 缺失清单', async () => {
    // 旧缺陷路径下模型会拿这句敷衍输出 completed——它在任何迭代里都不该被消费。
    mocks.responses.push(textResponse('假装干完了。'));
    mcpState.ensureConnected.mockImplementation(async () => false);
    const { request } = createHarness({
      availableTools: ['mcp__slow__*'],
      allowedToolNames: ['mcp__slow__work'],
      getDefinition: () => undefined,
    });

    const result = await new SubagentExecutor().execute(request);

    // 预判确实放行了该 server（形态不匹配 ≠ 无关名字），连接确实尝试过
    expect(mcpState.ensureConnected).toHaveBeenCalledWith('slow', expect.any(AbortSignal));
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('tool-unavailable');
    expect(result.missingTools).toEqual(['mcp__slow__*']);
    expect(result.error).toContain('mcp__slow__*');
    expect(result.iterations).toBe(0);
    expect(mocks.inference).not.toHaveBeenCalled();
  });

  it('混装：其余声明被白名单策略性滤掉 + 通配装配失败 ⇒ 仍失败，被滤掉的名字不算缺失', async () => {
    mcpState.ensureConnected.mockImplementation(async () => false);
    const { request } = createHarness({
      availableTools: ['Read', 'mcp__slow__*'],
      allowedToolNames: ['mcp__slow__work'],
      getDefinition: () => undefined,
    });

    const result = await new SubagentExecutor().execute(request);

    // Read 是被 run 策略排除（策略性排除 ≠ 装配失败）⇒ 不进缺失清单；通配失败进
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('tool-unavailable');
    expect(result.missingTools).toEqual(['mcp__slow__*']);
    expect(mocks.inference).not.toHaveBeenCalled();
  });

  it('通配装配失败 + 其余工具照常 ⇒ 部分缺失上报：成功带回 missingTools，通配绝不进模型工具表', async () => {
    mocks.responses.push(textResponse('读完了，MCP 没连上。'));
    mcpState.ensureConnected.mockImplementation(async () => false);
    const resolverDefs = new Map([['Read', makeDefinition('Read')]]);
    const { request } = createHarness({
      availableTools: ['Read', 'mcp__slow__*'],
      allowedToolNames: ['Read', 'mcp__slow__work'],
      getDefinition: (name) => resolverDefs.get(name),
    });

    const result = await new SubagentExecutor().execute(request);

    expect(result.success).toBe(true);
    expect(result.missingTools).toEqual(['mcp__slow__*']);
    expect(mocks.toolDefinitionSnapshots[0].map((tool) => tool.name)).toEqual(['Read']);
  });
});
