// ADR-068 刀 3：loop 层 B2 诚实分段与「先保片段再重发」收编 —— 锁住：
//  - stream_break 信号：断点 partial 以带 [连接中断] 标记的 assistant 消息落库（形态对齐
//    preserveStreamedPartial），turn 累积 reset，续答另起一段不 append 拼缝（D2 边界）；
//  - partial 不进 runtime.messages：重发请求与原请求逐字一致（D4 prompt cache 前提 +
//    末条 assistant 部分模型直接 400 的兼容面）；
//  - network retry / artifact 非流式重试：重发前先保片段（顺序上 persist 早于重发派发）；
//  - 推理终错（error 路径）补齐不落库缺口：partial 带 [生成中断] 标记保留后 throw；
//  - streamCallback error 分支：流中断在日志层可见（as-built 备注 1 收编，UI 信号是刀 4）；
//  - 空片段 no-op：首字节前失败没有可保的内容，不落空壳。
// 引擎无关编排层用 legacy 引擎 + mock modelRouter 驱动（对齐 inference.artifactRetry.test.ts
// 的夹具口径）；adapter 侧的 B1/B2 分流与 usage 合并见 aiSdkAdapterStreamResume.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import { inference } from '../../../src/host/agent/runtime/contextAssembly/inference';
import { logger } from '../../../src/host/agent/runtime/contextAssembly/shared';
import { retryEvents } from '../../../src/host/model/providers/retryStrategy';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import type { AgentEvent } from '../../../src/shared/contract/agent';
import type { StreamCallback } from '../../../src/host/model/types';

const { mockGetApiKey, mockGetSettings, mockAddMessageToSession } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockGetSettings: vi.fn(() => ({ models: { providers: {} } })),
  mockAddMessageToSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ getApiKey: mockGetApiKey, getSettings: mockGetSettings }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({
    startGenerationInSpan: vi.fn(),
    endGeneration: vi.fn(),
  }),
  getSessionManager: () => ({ addMessageToSession: mockAddMessageToSession }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    browser: vi.fn(),
  },
}));

const { mockToolDefinitions } = vi.hoisted(() => ({
  mockToolDefinitions: [
    { name: 'Read', description: 'read file', inputSchema: {} },
    { name: 'Write', description: 'write file', inputSchema: {} },
  ],
}));

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getCoreToolDefinitions: vi.fn().mockReturnValue(mockToolDefinitions),
  getLoadedDeferredToolDefinitions: vi.fn().mockReturnValue([]),
  getAllToolDefinitions: vi.fn().mockReturnValue(mockToolDefinitions),
  withDesignCanvasTools: vi.fn((tools) => tools),
  withoutGenericMediaToolsInDesign: vi.fn((tools) => tools),
}));

vi.mock('../../../src/host/tools/workbenchToolScope', () => ({
  filterToolDefinitionsByWorkbenchScope: vi.fn((tools) => tools),
}));

vi.mock('../../../src/host/session/streamSnapshot', () => ({
  createSnapshotHandler: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('../../../src/host/context/tokenOptimizer', () => ({
  estimateModelMessageTokens: vi.fn().mockReturnValue(12),
  estimateTokens: vi.fn().mockReturnValue(5),
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ContextLengthExceededError: class ContextLengthExceededError extends Error {
    requestedTokens = 0;
    maxTokens = 0;
    provider = 'mock';
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  needsArtifactTaskBrief: vi.fn((message: string) => /生成|html|game|write|create|build/i.test(message)),
}));

vi.mock('../../../src/host/platform/windowBridge', () => ({
  broadcastToRenderer: vi.fn(),
}));

function buildCtx(overrides: Partial<ContextAssemblyCtx['runtime']> = {}): ContextAssemblyCtx {
  const onEvent = vi.fn();
  const modelRouter = {
    inference: vi.fn(),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    getModelInfo: vi.fn().mockReturnValue({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: vi.fn().mockReturnValue(null),
    getVisionPreflightCandidates: vi.fn().mockReturnValue([]),
  };

  const runtime = {
    enableToolDeferredLoading: false,
    toolScope: undefined,
    stats: RunStatsState.forTest({ traceId: 'trace-1' } as never),
    turn: TurnState.forTest({ currentIterationSpanId: 'span-1', currentTurnId: 'turn-1', effortLevel: 'medium' }),
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
    onEvent,
    control: ControlState.forTest(),
    contextHealth: ContextHealthState.forTest(),
    messages: [],
    artifact: ArtifactState.forTest(),
    ...overrides,
  } as any;

  return {
    runtime,
    inferenceRecovery: {
      _contextOverflowRetried: false,
      _artifactNonStreamingRetried: false,
      _artifactRepairCompactWriteRetried: false,
      _networkRetried: false,
      consecutiveStreamBreakRounds: 0, // 与 ContextAssembly 初始化一致（缺省 undefined+1=NaN 会让熔断永不触发、测试假绿）
    },
    taskProgress: {
      emitTaskProgress: vi.fn(),
    } as any,
    recordTokenUsage: vi.fn(),
    inference: vi.fn(),
    buildModelMessages: vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: '正常回答这个问题' },
    ]),
    checkAndAutoCompress: vi.fn(),
    generateId: vi.fn(() => `partial-id-${Math.random().toString(36).slice(2, 8)}`),
    recordContextEventsForMessage: vi.fn(),
  } as any;
}

/** 从 onEvent 记录里取出指定类型的 message_delta 文本拼接。 */
function streamedText(ctx: ContextAssemblyCtx): string {
  return vi.mocked(ctx.runtime.onEvent).mock.calls
    .map(([event]: [AgentEvent]) => event)
    .filter((event) => event.type === 'message_delta')
    .map((event) => (event.data as { text?: string }).text ?? '')
    .join('');
}

/** retryEvents 'reconnect' 订阅（CLI 一行提示的事件通道；用例内挂/卸，不吃单例脏状态）。 */
const retryOnReconnect = vi.fn();
beforeEach(() => {
  retryEvents.on('reconnect', retryOnReconnect);
});
afterEach(() => {
  retryEvents.removeListener('reconnect', retryOnReconnect);
  retryOnReconnect.mockClear();
});

describe('contextAssembly inference —— 无人值守断流续接分档与熔断（ADR-068 D4）', () => {
  const prevEngine = process.env.CODE_AGENT_MODEL_ENGINE;
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKey.mockReturnValue('mock-key');
    mockGetSettings.mockReturnValue({ models: { providers: {} } });
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });
  afterEach(() => {
    if (prevEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = prevEngine;
  });

  /** 每次推理：broke=true 时先发一次 reconnecting（该轮遇到断流）。返回每次调用收到的 options。 */
  function driveRounds(ctx: ContextAssemblyCtx, rounds: boolean[]) {
    let i = 0;
    ctx.runtime.modelRouter.inference = vi.fn((_m, _t, _c, onStream?: StreamCallback) => {
      if (rounds[i++]) onStream?.({ type: 'reconnecting', attempt: 1, maxReconnects: 5, segment: 'b2' });
      return Promise.resolve({ type: 'text' as const, content: 'ok', finishReason: 'stop' });
    });
    return async () => {
      for (let n = 0; n < rounds.length; n++) await inference(ctx);
      return vi.mocked(ctx.runtime.modelRouter.inference).mock.calls.map((call) => call[5]?.streamReconnectMax);
    };
  }

  it('前台轮不传 streamReconnectMax（adapter 用默认 STREAM_RECONNECT_MAX，前台预算零改动），也不累计熔断', async () => {
    const ctx = buildCtx();
    const budgets = await driveRounds(ctx, [true, true, true, true])();
    expect(budgets).toEqual([undefined, undefined, undefined, undefined]);
  });

  it.each([
    ['显式无人值守轮（runtime.unattendedTurn；loop/会话级标记接线在后续 PR）', { unattendedTurn: true }],
    ['async_agent（budgetScope=unattended）', { budgetScope: 'unattended' }],
    ['goal 模式', { goalMode: { isPending: () => false } }],
  ])('%s → 续接预算取 UNATTENDED_STREAM_RECONNECT_MAX=5', async (_label, overrides) => {
    const ctx = buildCtx(overrides as any);
    const budgets = await driveRounds(ctx, [false])();
    expect(budgets).toEqual([5]);
  });

  it('熔断：同 run 连续 3 轮断流后预算置 0；中间一轮无断流即清零重计', async () => {
    const ctx = buildCtx({ unattendedTurn: true } as any);
    // 轮 1-2 断流、轮 3 干净（清零）、轮 4-6 断流（连续 3）、轮 7 被熔断
    const budgets = await driveRounds(ctx, [true, true, false, true, true, true, false])();
    expect(budgets).toEqual([5, 5, 5, 5, 5, 5, 0]);
  });

  it('熔断不被熔断轮自身的失败解除：预算 0 的轮断流抛错（adapter 不发 reconnecting）后，下一轮预算仍为 0', async () => {
    const ctx = buildCtx({ unattendedTurn: true } as any);
    let i = 0;
    ctx.runtime.modelRouter.inference = vi.fn((_m, _t, _c, onStream?: StreamCallback) => {
      i += 1;
      if (i <= 3) onStream?.({ type: 'reconnecting', attempt: 1, maxReconnects: 5, segment: 'b2' });
      if (i === 4) return Promise.reject(new Error('stream break while circuit open'));
      return Promise.resolve({ type: 'text' as const, content: 'ok', finishReason: 'stop' });
    });
    for (let n = 0; n < 5; n++) await inference(ctx).catch(() => undefined);
    const budgets = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls.map((call) => call[5]?.streamReconnectMax);
    expect(budgets.slice(0, 5)).toEqual([5, 5, 5, 0, 0]);
  });
});

describe('contextAssembly inference —— B2 诚实分段与重发收编（ADR-068 刀 3）', () => {
  // 引擎无关编排断言打在 mock modelRouter.inference 上（口径同 inference.artifactRetry.test.ts）。
  const prevEngine = process.env.CODE_AGENT_MODEL_ENGINE;
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKey.mockReturnValue('mock-key');
    mockGetSettings.mockReturnValue({ models: { providers: {} } });
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });
  afterEach(() => {
    if (prevEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = prevEngine;
  });

  it('stream_break：断点 partial 带中断标记落库，续答另起一段不 append 拼缝，partial 不进重发上下文', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn((_messages, _tools, _cfg, onStream?: StreamCallback) => {
      onStream?.({ type: 'text', content: '断点片段。' });
      // adapter 决定断流重发（B2）：loop 层先保片段再收续写 delta
      onStream?.({ type: 'stream_break', error: 'ECONNRESET' });
      onStream?.({ type: 'text', content: '续答正文。' });
      return Promise.resolve({ type: 'text' as const, content: '续答正文。', finishReason: 'stop' });
    });

    const response = await inference(ctx);

    // B2 两段式落库：partial 是独立的一条 assistant 消息，带 [连接中断] 标记（形态对齐
    // preserveStreamedPartial 的正文后缀协议），续答由 response 走正常落库成为新消息。
    const persistMessage = vi.mocked(ctx.runtime.persistMessage as unknown as ReturnType<typeof vi.fn>);
    expect(persistMessage).toHaveBeenCalledTimes(1);
    const partial = persistMessage.mock.calls[0][0];
    expect(partial.role).toBe('assistant');
    expect(partial.content).toBe('断点片段。\n\n[连接中断 — 部分回答已保留]');
    // 不 append 拼缝：续答从 reset 后的空累积起头，turn 里只有续答段
    expect(ctx.runtime.turn.lastStreamedContent).toBe('续答正文。');
    // partial 不进 runtime.messages：重发请求与原请求逐字一致（D4 + D1 末条 assistant 兼容面）
    expect(JSON.stringify(ctx.runtime.messages)).not.toContain('连接中断');
    expect(response.content).toBe('续答正文。');
    // renderer 的 message_delta append 通道两段照发（呈现分野是刀 4）：数据层分段以落库为准
    expect(streamedText(ctx)).toBe('断点片段。续答正文。');
  });

  it('reconnecting（刀 4 信号）：转成 stream_reconnecting agent 事件（turnId + n/N + 分档），呈现层据此内嵌状态行', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn((_messages, _tools, _cfg, onStream?: StreamCallback) => {
      onStream?.({ type: 'text', content: '断点片段。' });
      // B2：信号先于 stream_break（同一分流点发出，呈现与分段落库同源）
      onStream?.({ type: 'reconnecting', attempt: 1, maxReconnects: 2, segment: 'b2' });
      onStream?.({ type: 'stream_break', error: 'ECONNRESET' });
      onStream?.({ type: 'text', content: '续答正文。' });
      return Promise.resolve({ type: 'text' as const, content: '续答正文。', finishReason: 'stop' });
    });

    await inference(ctx);

    // 稳定 code + 计数转发给 renderer（文案在 renderer i18n，host 不写中文文案）；
    // 同一轮不重置 turn：事件带的就是当前 turnId
    const events = vi.mocked(ctx.runtime.onEvent).mock.calls
      .map(([event]: [AgentEvent]) => event)
      .filter((event) => event.type === 'stream_reconnecting');
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({
      turnId: 'turn-1',
      attempt: 1,
      maxReconnects: 2,
      segment: 'b2',
    });
  });

  it('reconnecting 缺字段兜底：attempt/maxReconnects/segment 缺省按 1/1/b2 转发（不让呈现层拿 undefined）', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn((_messages, _tools, _cfg, onStream?: StreamCallback) => {
      onStream?.({ type: 'text', content: '片段。' });
      onStream?.({ type: 'reconnecting' });
      onStream?.({ type: 'stream_break', error: 'ECONNRESET' });
      return Promise.resolve({ type: 'text' as const, content: 'ok', finishReason: 'stop' });
    });

    await inference(ctx);

    const events = vi.mocked(ctx.runtime.onEvent).mock.calls
      .map(([event]: [AgentEvent]) => event)
      .filter((event) => event.type === 'stream_reconnecting');
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ turnId: 'turn-1', attempt: 1, maxReconnects: 1, segment: 'b2' });
  });

  it('stream_break：persistMessage 未注入时降级 sessionManager.addMessageToSession（PR #1828 复审 Important）', async () => {
    const ctx = buildCtx(); // 不注入 persistMessage
    ctx.runtime.modelRouter.inference = vi.fn((_messages, _tools, _cfg, onStream?: StreamCallback) => {
      onStream?.({ type: 'text', content: '断点片段。' });
      onStream?.({ type: 'stream_break', error: 'ECONNRESET' });
      onStream?.({ type: 'text', content: '续答正文。' });
      return Promise.resolve({ type: 'text' as const, content: '续答正文。', finishReason: 'stop' });
    });

    const response = await inference(ctx);

    expect(response.content).toBe('续答正文。');
    // 保片段是 fire-and-forget：等微任务排空再断言（对齐 addAndPersistMessage 的降级链）
    await vi.waitFor(() => expect(mockAddMessageToSession).toHaveBeenCalledTimes(1));
    const [sessionId, partial] = mockAddMessageToSession.mock.calls[0] as unknown as [string, { content: string }];
    expect(sessionId).toBe('session-1');
    expect(partial.content).toBe('断点片段。\n\n[连接中断 — 部分回答已保留]');
  });

  it('network retry：重发前先保片段（persist 早于重发派发），重发消息不含 partial，turn 不拼缝', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockImplementationOnce((_messages, _tools, _cfg, onStream?: StreamCallback) => {
        onStream?.({ type: 'text', content: '旧尝试片段。' });
        return Promise.reject(new Error('Network request failed: socket hang up'));
      })
      .mockImplementationOnce((_messages, _tools, _cfg, onStream?: StreamCallback) => {
        onStream?.({ type: 'text', content: '重发后的回答。' });
        return Promise.resolve({ type: 'text' as const, content: '重发后的回答。', finishReason: 'stop' });
      });
    ctx.inference = vi.fn(() => inference(ctx));

    const response = await inference(ctx);

    expect(response.content).toBe('重发后的回答。');
    expect(vi.mocked(ctx.runtime.modelRouter.inference)).toHaveBeenCalledTimes(2);
    const persistMessage = vi.mocked(ctx.runtime.persistMessage as unknown as ReturnType<typeof vi.fn>);
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(persistMessage.mock.calls[0][0].content).toBe('旧尝试片段。\n\n[连接中断 — 部分回答已保留]');
    // 顺序：先保片段，再重发（as-built 备注 1 收编的核心承诺）
    expect(persistMessage.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ctx.runtime.modelRouter.inference).mock.invocationCallOrder[1]);
    // 重发请求与原请求逐字一致：partial 没有混进重发的 messages
    const [retryMessages] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[1];
    expect(JSON.stringify(retryMessages)).not.toContain('旧尝试片段');
    // turn 累积只有重发段：resetStreamedContent 不再丢片段，也不把两代生成拼在一起
    expect(ctx.runtime.turn.lastStreamedContent).toBe('重发后的回答。');
    // 刀 4 信号：loop 层网络重发与 adapter 续接同形——发 stream_reconnecting（n/N 取自
    // 本层预算，segment 恒 b2：loop 重发永远是诚实分段），CLI 走 retryEvents reconnect
    const signalEvents = vi.mocked(ctx.runtime.onEvent).mock.calls
      .map(([event]: [AgentEvent]) => event)
      .filter((event) => event.type === 'stream_reconnecting');
    expect(signalEvents).toHaveLength(1);
    expect(signalEvents[0].data).toEqual({ turnId: 'turn-1', attempt: 1, maxReconnects: 1, segment: 'b2' });
    expect(retryOnReconnect).toHaveBeenCalledTimes(1);
    expect(retryOnReconnect).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      maxReconnects: 1,
      segment: 'b2',
      error: 'Network request failed: socket hang up',
    }));
  });

  it('artifact 非流式重试：已吐 delta 后的重试同样先保片段再重发', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.buildModelMessages = vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: '生成一个单文件 HTML game' },
    ]);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockImplementationOnce((_messages, _tools, _cfg, onStream?: StreamCallback) => {
        onStream?.({ type: 'text', content: '生成中断前的说明文字。' });
        return Promise.reject(new Error('[Xiaomi] stream ended before [DONE] with tool calls; refusing to execute incomplete tool arguments'));
      })
      .mockResolvedValueOnce({ type: 'text', content: 'recovered', finishReason: 'stop' });

    const response = await inference(ctx);

    expect(response.content).toBe('recovered');
    expect(vi.mocked(ctx.runtime.modelRouter.inference)).toHaveBeenCalledTimes(2);
    // persistMessage 会有两条：partial（assistant）+ writeAgentRecoveryNotice 的重试告知
    // （system）——只断言 assistant partial 这一条的分段形态与顺序。
    const persistMessage = vi.mocked(ctx.runtime.persistMessage as unknown as ReturnType<typeof vi.fn>);
    const partialCalls = persistMessage.mock.calls.filter(([m]) => m.role === 'assistant');
    expect(partialCalls).toHaveLength(1);
    expect(partialCalls[0][0].content)
      .toBe('生成中断前的说明文字。\n\n[连接中断 — 部分回答已保留]');
    expect(persistMessage.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ctx.runtime.modelRouter.inference).mock.invocationCallOrder[1]);
  });

  it('推理终错：partial 带 [生成中断] 标记保留后 throw（补齐 error 路径不落库的缺口）', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockImplementationOnce((_messages, _tools, _cfg, onStream?: StreamCallback) => {
        onStream?.({ type: 'text', content: '会沉没的片段。' });
        return Promise.reject(new Error('401 Unauthorized: invalid api key'));
      });

    await expect(inference(ctx)).rejects.toThrow(/401 Unauthorized/);

    const persistMessage = vi.mocked(ctx.runtime.persistMessage as unknown as ReturnType<typeof vi.fn>);
    expect(persistMessage).toHaveBeenCalledTimes(1);
    const partial = persistMessage.mock.calls[0][0];
    expect(partial.role).toBe('assistant');
    expect(partial.content).toBe('会沉没的片段。\n\n[生成中断 — 部分回答已保留]');
    expect(ctx.runtime.turn.lastStreamedContent).toBe('');
  });

  it('streamCallback error 分支：流中断在日志层可见（中断原因 + errorCode）', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockImplementationOnce((_messages, _tools, _cfg, onStream?: StreamCallback) => {
        onStream?.({ type: 'text', content: '片段。' });
        onStream?.({ type: 'error', error: '连接已断开', errorCode: 'ECONNRESET' });
        return Promise.reject(new Error('Network request failed: socket hang up'));
      })
      .mockResolvedValueOnce({ type: 'text', content: 'ok', finishReason: 'stop' });
    ctx.inference = vi.fn(() => inference(ctx));

    await inference(ctx);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[AgentLoop] 流式中断（streamCallback error 分支）:',
      '连接已断开',
      'ECONNRESET',
    );
  });

  it('首字节前失败没有可保内容：不落空壳 partial', async () => {
    const ctx = buildCtx({ persistMessage: vi.fn().mockResolvedValue(undefined) } as any);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockRejectedValueOnce(new Error('Network request failed: socket hang up'))
      .mockResolvedValueOnce({ type: 'text', content: 'ok', finishReason: 'stop' });
    ctx.inference = vi.fn(() => inference(ctx));

    const response = await inference(ctx);

    expect(response.content).toBe('ok');
    expect(ctx.runtime.persistMessage).not.toHaveBeenCalled();
  });
});
