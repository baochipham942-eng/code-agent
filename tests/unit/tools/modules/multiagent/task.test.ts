// ============================================================================
// Task (native ToolModule) Tests — Wave 3 multiagent
// 关键：opaque service handle (modelConfig/resolver/hookManager) 取自 ctx，
// 不在 protocol 层引入业务类型；通过 buildLegacyCtxFromProtocol 桥接到
// SubagentExecutor（cross-cat dispatch）。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

// ----- Mocks (vi.mock 上提到顶部，所以 mock 内部访问的变量必须 hoisted) -----
const { executorExecuteMock, taskDedupMock } = vi.hoisted(() => ({
  executorExecuteMock: vi.fn(),
  taskDedupMock: {
    isDuplicate: vi.fn(),
    registerTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  },
}));

vi.mock('../../../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: executorExecuteMock }),
}));

vi.mock('../../../../../src/main/agent/taskDeduplication', () => ({
  taskDeduplication: taskDedupMock,
}));

vi.mock('../../../../../src/main/agent/agentDefinition', () => ({
  CORE_AGENT_IDS: ['coder', 'reviewer', 'explore', 'plan', 'awaiter'],
  isCoreAgent: (s: string) => ['coder', 'reviewer', 'explore', 'plan', 'awaiter'].includes(s),
  getPredefinedAgent: (id: string) =>
    ['coder', 'reviewer', 'explore', 'plan', 'awaiter'].includes(id)
      ? { id, name: id[0].toUpperCase() + id.slice(1), tools: ['read'], systemPrompt: 'sys' }
      : undefined,
  listPredefinedAgents: () => [{ id: 'coder' }, { id: 'reviewer' }],
  getAgentPrompt: () => 'system-prompt',
  getAgentTools: () => ['read'],
  getAgentDynamicMaxIterations: () => 10,
  getAgentPermissionPreset: () => 'development',
  getAgentMaxBudget: () => 1.0,
  getSubagentModelConfig: () => ({ provider: 'kimi', model: 'kimi-k2.5' }),
}));

vi.mock('../../../../../src/main/agent/subagentContextBuilder', () => ({
  SubagentContextBuilder: class {
    async build() { return {}; }
    formatForSystemPrompt() { return ''; }
  },
  getAgentContextLevel: () => 'relevant',
}));

vi.mock('../../../../../src/main/tools/modules/_helpers/legacyAdapter', () => ({
  buildLegacyCtxFromProtocol: (ctx: ToolContext) => ({ workingDirectory: ctx.workingDir }),
}));

import { taskModule } from '../../../../../src/main/tools/modules/multiagent/task';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    resolver: { execute: vi.fn() },
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  taskDedupMock.isDuplicate.mockReturnValue({ isDuplicate: false });
  taskDedupMock.registerTask.mockReturnValue('hash-1');
});

describe('Task schema', () => {
  it('对齐 legacy schema (required: prompt + subagent_type)', () => {
    expect(taskModule.schema.name).toBe('Task');
    expect(taskModule.schema.inputSchema.required).toEqual(['prompt', 'subagent_type']);
    expect(taskModule.schema.category).toBe('multiagent');
    expect(taskModule.schema.permissionLevel).toBe('execute');
  });
});

describe('Task validation', () => {
  it('缺 subagent_type → INVALID_ARGS', async () => {
    const handler = await taskModule.createHandler();
    const result = await handler.execute({ prompt: 'hi' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Missing subagent_type');
    }
  });

  it('subagent_type 含 XML 标签时 strip 修复', async () => {
    executorExecuteMock.mockResolvedValue({ success: true, output: 'ok', iterations: 1, toolsUsed: [] });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'hi', subagent_type: '<arg_value>coder</arg_value>' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
  });

  it('未知 subagent_type → 模糊匹配建议', async () => {
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'hi', subagent_type: 'codr' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Did you mean "coder"');
    }
  });

  it('缺 prompt → INVALID_ARGS', async () => {
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { subagent_type: 'coder', prompt: '' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });
});

describe('Task five-link gates', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'go', subagent_type: 'coder' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'go', subagent_type: 'coder' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('opaque service handle: 缺 ctx.modelConfig → NOT_INITIALIZED', async () => {
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'go', subagent_type: 'coder' },
      makeCtx({ modelConfig: undefined }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
  });
});

describe('Task happy / failure', () => {
  it('happy: SubagentExecutor success → 输出复刻 legacy', async () => {
    executorExecuteMock.mockResolvedValue({
      success: true,
      output: 'all done',
      iterations: 5,
      toolsUsed: ['read', 'edit'],
      cost: 0.0123,
      tokensUsed: 345,
    });
    const handler = await taskModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { prompt: 'do thing', subagent_type: 'coder', description: 'short' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Agent [Coder] completed (short):');
      expect(result.output).toContain('all done');
      expect(result.output).toContain('- Iterations: 5');
      expect(result.output).toContain('- Tools used: read, edit');
      expect(result.output).toContain('- Cost: $0.0123');
      expect(result.meta).toMatchObject({
        tool: 'Task',
        category: 'multiagent',
        action: 'task',
        agentId: 'coder',
        status: 'completed',
        targets: ['coder'],
        counts: { iterations: 5, tools: 2 },
        request: {
          args: {
            prompt: { type: 'string', length: 8, preview: 'do thing' },
            subagent_type: 'coder',
            description: { type: 'string', length: 5, preview: 'short' },
          },
        },
        bridge: { protocolContext: true, legacyContext: false },
        artifactRole: 'multiagent-result',
        result: {
          agentName: 'Coder',
          subagentType: 'coder',
          description: 'short',
          output: 'all done',
          iterations: 5,
          toolsUsed: ['read', 'edit'],
          cost: 0.0123,
          tokensUsed: 345,
        },
        artifact: expect.objectContaining({ kind: 'text', sourceTool: 'Task' }),
        artifacts: [expect.objectContaining({ kind: 'text', sourceTool: 'Task' })],
      });
      expect(result.meta.artifact).toMatchObject({
        metadata: expect.objectContaining({
          tool: 'Task',
          action: 'task',
          status: 'completed',
          targets: ['coder'],
          counts: { iterations: 5, tools: 2 },
        }),
      });
    }
    expect(taskDedupMock.completeTask).toHaveBeenCalledWith('hash-1', 'all done');
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'Task' });
  });

  it('passes parent timeout and remaining budget to the child executor', async () => {
    executorExecuteMock.mockResolvedValue({
      success: true,
      output: 'ok',
      iterations: 1,
      toolsUsed: [],
      cost: 0.01,
      tokensUsed: 12,
    });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'do thing', subagent_type: 'coder' },
      makeCtx({
        parentRemainingBudget: 0.42,
        spawnParentStartedAt: 1_000,
        spawnParentTimeoutMs: 10_000,
      } as never),
      allowAll,
    );

    expect(result.ok).toBe(true);
    const executorCtx = executorExecuteMock.mock.calls[0][2];
    expect(executorCtx.parentRemainingBudget).toBe(0.42);
    expect(executorCtx.toolContext).toMatchObject({
      spawnParentStartedAt: 1_000,
      spawnParentTimeoutMs: 10_000,
    });
  });

  it('SubagentExecutor failure → DOMAIN_ERROR + dedup failTask', async () => {
    executorExecuteMock.mockResolvedValue({
      success: false,
      error: 'rate limit',
      output: '',
      iterations: 0,
      toolsUsed: [],
    });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'do thing', subagent_type: 'coder' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('rate limit');
      expect(result.meta).toMatchObject({
        tool: 'Task',
        action: 'task',
        status: 'failed',
        agentId: 'coder',
        targets: ['coder'],
        counts: { iterations: 0, tools: 0 },
        request: {
          args: {
            prompt: { type: 'string', length: 8, preview: 'do thing' },
            subagent_type: 'coder',
          },
        },
        bridge: { protocolContext: true, legacyContext: false },
      });
    }
    expect(taskDedupMock.failTask).toHaveBeenCalled();
  });

  it('SubagentExecutor throw → DOMAIN_ERROR + failTask', async () => {
    executorExecuteMock.mockRejectedValue(new Error('boom'));
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'do thing', subagent_type: 'coder' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('boom');
    }
  });

  it('dedup hit with cached result → 返回缓存', async () => {
    taskDedupMock.isDuplicate.mockReturnValue({ isDuplicate: true, cachedResult: 'cached' });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'go', subagent_type: 'coder' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('[缓存结果] cached');
    expect(executorExecuteMock).not.toHaveBeenCalled();
  });

  it('dedup hit no cache → DOMAIN_ERROR (任务已在跑)', async () => {
    taskDedupMock.isDuplicate.mockReturnValue({ isDuplicate: true, reason: 'in flight' });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'go', subagent_type: 'coder' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toBe('in flight');
    }
  });
});

describe('Task adaptive 泄漏修复（ADR-019 批 1）', () => {
  it('父会话 adaptive=true 不泄漏给 subagent：executor 收到 adaptive=false', async () => {
    executorExecuteMock.mockResolvedValue({ success: true, output: 'ok', iterations: 1, toolsUsed: [] });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'do thing', subagent_type: 'coder' },
      makeCtx({
        modelConfig: { provider: 'deepseek', model: 'deepseek-chat', adaptive: true },
      } as never),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(executorExecuteMock).toHaveBeenCalled();

    const executorOpts = executorExecuteMock.mock.calls[0][2];
    // 泄漏修复：subagent 的 modelConfig 必须显式 adaptive=false
    expect(executorOpts.modelConfig.adaptive).toBe(false);
    // 角色分层结果不受影响（mock 的 getSubagentModelConfig 返回 kimi/kimi-k2.5）
    expect(executorOpts.modelConfig.provider).toBe('kimi');
    expect(executorOpts.modelConfig.model).toBe('kimi-k2.5');
  });

  it('父会话无 adaptive 标志时同样显式置 false（防御未来回归）', async () => {
    executorExecuteMock.mockResolvedValue({ success: true, output: 'ok', iterations: 1, toolsUsed: [] });
    const handler = await taskModule.createHandler();
    const result = await handler.execute(
      { prompt: 'do thing', subagent_type: 'coder' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(executorExecuteMock).toHaveBeenCalled();
    const executorOpts = executorExecuteMock.mock.calls[0][2];
    expect(executorOpts.modelConfig.adaptive).toBe(false);
  });
});
