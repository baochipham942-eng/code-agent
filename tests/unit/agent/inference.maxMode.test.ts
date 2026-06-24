// ============================================================================
// Max Mode 接线层测试 — inference.ts 在引擎调用处按 runtime.maxMode 分叉。
// mock 模式照 inference.artifactRetry.test.ts：强制 legacy 引擎，断言打在
// modelRouter.inference 上（签名: messages, tools, config, onStream, signal, options）。
// 关闭态行为一致性由既有 inference.artifactRetry.test.ts 全量用例保证（maxMode
// 未设置 = falsy = 走原路径），本文件补一个显式 off 用例兜底。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/main/agent/runtime/contextAssembly';
import { inference } from '../../../src/main/agent/runtime/contextAssembly/inference';

const { mockGetApiKey, mockRecordUsage, mockCheckBudget } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockRecordUsage: vi.fn(),
  mockCheckBudget: vi.fn(() => ({ alertLevel: 'none', usagePercentage: 0 })),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/main/services', () => ({
  getConfigService: () => ({ getApiKey: mockGetApiKey }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({
    startGenerationInSpan: vi.fn(),
    endGeneration: vi.fn(),
  }),
  getBudgetService: () => ({
    recordUsage: mockRecordUsage,
    checkBudget: mockCheckBudget,
  }),
  BudgetAlertLevel: { NONE: 'none', SILENT: 'silent', WARNING: 'warning', BLOCKED: 'blocked' },
}));

vi.mock('../../../src/main/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    browser: vi.fn(),
  },
}));

const { mockToolDefinitions } = vi.hoisted(() => ({
  mockToolDefinitions: [
    { name: 'Read', description: 'read file', inputSchema: {} },
    { name: 'Edit', description: 'edit file', inputSchema: {} },
  ],
}));

vi.mock('../../../src/main/tools/dispatch/toolDefinitions', () => ({
  getCoreToolDefinitions: vi.fn().mockReturnValue(mockToolDefinitions),
  getLoadedDeferredToolDefinitions: vi.fn().mockReturnValue([]),
  getAllToolDefinitions: vi.fn().mockReturnValue(mockToolDefinitions),
  withDesignCanvasTools: vi.fn((tools) => tools),
}));

vi.mock('../../../src/main/tools/workbenchToolScope', () => ({
  filterToolDefinitionsByWorkbenchScope: vi.fn((tools) => tools),
}));

vi.mock('../../../src/main/session/streamSnapshot', () => ({
  createSnapshotHandler: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('../../../src/main/context/tokenOptimizer', () => ({
  estimateModelMessageTokens: vi.fn().mockReturnValue(12),
  estimateTokens: vi.fn().mockReturnValue(5),
}));

vi.mock('../../../src/main/model/modelRouter', () => ({
  ContextLengthExceededError: class ContextLengthExceededError extends Error {
    requestedTokens = 0;
    maxTokens = 0;
    provider = 'mock';
  },
}));

vi.mock('../../../src/main/prompts/builder', () => ({
  needsArtifactTaskBrief: vi.fn().mockReturnValue(false),
}));

function buildCtx(overrides: Partial<ContextAssemblyCtx['runtime']> = {}): ContextAssemblyCtx {
  const modelRouter = {
    inference: vi.fn().mockResolvedValue({ type: 'text', content: 'single', finishReason: 'stop' }),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    getModelInfo: vi.fn().mockReturnValue({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: vi.fn().mockReturnValue(null),
    getVisionPreflightCandidates: vi.fn().mockReturnValue([]),
  };

  const runtime = {
    enableToolDeferredLoading: false,
    toolScope: undefined,
    forceFinalResponsePrompt: undefined,
    forceFinalResponseReason: undefined,
    traceId: 'trace-1',
    currentIterationSpanId: 'span-1',
    currentTurnId: 'turn-1',
    sessionId: 'session-1',
    workingDirectory: '/tmp',
    modelConfig: {
      provider: 'mock',
      model: 'test-model',
      apiKey: 'mock-key',
      temperature: 0,
      maxTokens: 4096,
    },
    modelRouter,
    onEvent: vi.fn(),
    abortController: null,
    lastStreamedContent: '',
    needsReinference: false,
    isInterrupted: false,
    isCancelled: false,
    effortLevel: 'medium',
    messages: [],
    maxMode: false,
    maxModeCandidates: 3,
    _contextOverflowRetried: false,
    _artifactNonStreamingRetried: false,
    _artifactRepairCompactWriteRetried: false,
    _networkRetried: false,
    ...overrides,
  } as any;

  return {
    runtime,
    taskProgress: {
      emitTaskProgress: vi.fn(),
    } as any,
    recordTokenUsage: vi.fn(),
    inference: vi.fn(),
    buildModelMessages: vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: '修复这个 bug' },
    ]),
    checkAndAutoCompress: vi.fn(),
  } as any;
}

describe('inference Max Mode wiring', () => {
  const prevEngine = process.env.CODE_AGENT_MODEL_ENGINE;
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKey.mockReturnValue('mock-key');
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });
  afterEach(() => {
    if (prevEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = prevEngine;
  });

  it('开关关（默认）→ 引擎只调一次且带流式回调，行为与原路径一致', async () => {
    const ctx = buildCtx({ maxMode: false } as any);

    const response = await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, , , onStream] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(typeof onStream).toBe('function');
    expect(response.content).toBe('single');
    expect(response.runtimeDiagnostics?.maxMode).toBeUndefined();
    // 关闭态 model_decision 事件照常发出（行为与 main 一致）
    const decisionEvents = vi.mocked(ctx.runtime.onEvent).mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'model_decision',
    );
    expect(decisionEvents).toHaveLength(1);
  });

  // 异常路径漏记 token 修复：普通（非 Max Mode）推理中断时，本轮已派发请求的
  // input tokens 是真实沉没成本，必须记一次（此前 abort 分支直接返回空，零记账）。
  it('普通路径中断（取消）→ 记一次 input 沉没成本，不再静默漏记', async () => {
    const ctx = buildCtx({ maxMode: false } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockImplementation(async () => {
      ctx.runtime.isCancelled = true; // 流式中途用户取消
      throw new Error('aborted');
    });

    const response = await inference(ctx);

    expect(response.type).toBe('text');
    expect(response.content ?? '').toBe('');
    // estimateModelMessageTokens 被 mock 为固定 12；output 中断时不估算 → 0
    expect(ctx.recordTokenUsage).toHaveBeenCalledWith(12, 0);
  });

  it('开关开 → N 候选（无流式回调）+ judge（无工具），返回赢家并附 maxMode 诊断', async () => {
    const ctx = buildCtx({ maxMode: true, maxModeCandidates: 3 } as any);
    let candidateCount = 0;
    ctx.runtime.modelRouter.inference = vi.fn().mockImplementation(
      async (_messages: unknown, tools: unknown[]) => {
        if (tools.length === 0) {
          // judge 调用
          return { type: 'text', content: '候选 1 提议了 Edit(a.ts)。\nWINNER: 1', finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 8 } };
        }
        candidateCount++;
        return {
          type: 'tool_use',
          toolCalls: [{ id: `c${candidateCount}`, name: 'Edit', arguments: { path: 'a.ts', n: candidateCount } }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 100, outputTokens: candidateCount * 10 },
        };
      },
    );

    const response = await inference(ctx);

    // 3 候选 + 1 judge
    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls;
    // 候选调用（带工具）一律无流式回调（propose-only 无 UI 副作用）
    const candidateCalls = calls.filter((c) => (c[1] as unknown[]).length > 0);
    expect(candidateCalls).toHaveLength(3);
    for (const call of candidateCalls) {
      expect(call[3]).toBeUndefined();
    }
    // judge 调用：无工具、无流式回调
    const judgeCalls = calls.filter((c) => (c[1] as unknown[]).length === 0);
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0][3]).toBeUndefined();

    // 赢家 = 候选 1（第二个完成的候选）
    expect(response.type).toBe('tool_use');
    expect(response.toolCalls?.[0].arguments).toMatchObject({ n: 2 });
    // 赢家 usage 原样保留（走正常上下文/统计路径）
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    // 诊断附着
    expect(response.runtimeDiagnostics?.maxMode).toMatchObject({
      candidates: 3,
      survivors: 3,
      winner: 1,
      degraded: false,
      judgeParsed: true,
    });

    // overhead：落选候选(100+10, 100+30) + judge(200+8) 逐条进 budgetService
    // （Codex R1-M2：按实际路由模型分账；mock 响应无 actualModel → 回落请求模型）；
    // 赢家自己的估算照常走 ctx.recordTokenUsage（mock 估算恒 12）
    const overheadRecorded = mockRecordUsage.mock.calls.map((c) => c[0]);
    expect(overheadRecorded).toHaveLength(3);
    expect(overheadRecorded.reduce((s, u) => s + u.inputTokens, 0)).toBe(400);
    expect(overheadRecorded.reduce((s, u) => s + u.outputTokens, 0)).toBe(48);
    for (const entry of overheadRecorded) {
      expect(entry.model).toBe('test-model');
      expect(entry.provider).toBe('mock');
    }
    expect(ctx.recordTokenUsage).toHaveBeenCalledWith(12, 12);
    expect(ctx.recordTokenUsage).toHaveBeenCalledTimes(1);

    // Codex R1-M1：候选/judge 的静默调用不发 model_decision 事件
    const decisionEvents = vi.mocked(ctx.runtime.onEvent).mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'model_decision',
    );
    expect(decisionEvents).toHaveLength(0);
  });

  it('全候选失败 → 降级单次流式调用，用户无感、无 overhead', async () => {
    const ctx = buildCtx({ maxMode: true, maxModeCandidates: 2 } as any);
    let calls = 0;
    ctx.runtime.modelRouter.inference = vi.fn().mockImplementation(
      async (_messages: unknown, _tools: unknown[], _config: unknown, onStream: unknown) => {
        calls++;
        if (calls <= 2) throw new Error('candidate boom');
        // 降级调用必须带流式回调（与正常主链路一致）
        expect(typeof onStream).toBe('function');
        return { type: 'text', content: 'degraded', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 5 } };
      },
    );

    const response = await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(3);
    expect(response.content).toBe('degraded');
    expect(response.runtimeDiagnostics?.maxMode).toMatchObject({ degraded: true, survivors: 0 });
    // 降级调用是正常主链路，无 overhead 记账（只有赢家估算那一笔）
    expect(ctx.recordTokenUsage).toHaveBeenCalledTimes(1);
    expect(ctx.recordTokenUsage).toHaveBeenCalledWith(12, 12);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  // Codex R1-H3：预算告警/封锁时不做 N 倍扇出，直接走正常单次调用
  it('budget 处于 warning/blocked → 跳过 Max Mode，按正常单次流式调用执行', async () => {
    mockCheckBudget.mockReturnValueOnce({ alertLevel: 'warning', usagePercentage: 0.9 });
    const ctx = buildCtx({ maxMode: true, maxModeCandidates: 5 } as any);

    const response = await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, , , onStream] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(typeof onStream).toBe('function');
    expect(response.content).toBe('single');
    expect(response.runtimeDiagnostics?.maxMode).toBeUndefined();
  });

  // Codex R1-H2：候选期间取消 → 不放出部分赢家，走既有取消语义（空文本响应）
  it('候选期间用户取消 → 不返回部分赢家，返回空文本（与正常路径取消语义一致）', async () => {
    const ctx = buildCtx({ maxMode: true, maxModeCandidates: 2 } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockImplementation(async () => {
      ctx.runtime.isCancelled = true; // 候选返回前用户取消
      return { type: 'tool_use', toolCalls: [{ id: 'x', name: 'Edit', arguments: {} }], finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1 } };
    });

    const response = await inference(ctx);

    expect(response.type).toBe('text');
    expect(response.content ?? '').toBe('');
    expect(response.toolCalls ?? []).toHaveLength(0);

    // Codex R2-M1：中止时已完成候选的沉没成本仍要记账（2 候选 × 10 in/1 out）
    const sunk = mockRecordUsage.mock.calls.map((c) => c[0]);
    expect(sunk.reduce((s, u) => s + u.inputTokens, 0)).toBe(20);
    expect(sunk.reduce((s, u) => s + u.outputTokens, 0)).toBe(2);
  });

  // Codex R1-M2：adaptive 路由后的 overhead 按实际模型分账
  it('候选被路由到不同模型 → overhead 以 actualProvider/actualModel 记账', async () => {
    const ctx = buildCtx({ maxMode: true, maxModeCandidates: 2 } as any);
    let n = 0;
    ctx.runtime.modelRouter.inference = vi.fn().mockImplementation(
      async (_messages: unknown, tools: unknown[]) => {
        if (tools.length === 0) {
          return { type: 'text', content: 'WINNER: 0', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 2 }, actualProvider: 'zhipu', actualModel: 'glm-free' };
        }
        n++;
        return { type: 'text', content: `c${n}`, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 }, actualProvider: 'zhipu', actualModel: 'glm-free' };
      },
    );

    await inference(ctx);

    const entries = mockRecordUsage.mock.calls.map((c) => c[0]);
    expect(entries).toHaveLength(2); // 落选 c2 + judge
    for (const entry of entries) {
      expect(entry.provider).toBe('zhipu');
      expect(entry.model).toBe('glm-free');
    }
  });
});
