import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/main/agent/runtime/contextAssembly';
import { inference } from '../../../src/main/agent/runtime/contextAssembly/inference';

const { mockGetApiKey, mockGetSettings } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockGetSettings: vi.fn(() => ({ models: { providers: {} } })),
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
  getConfigService: () => ({ getApiKey: mockGetApiKey, getSettings: mockGetSettings }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({
    startGenerationInSpan: vi.fn(),
    endGeneration: vi.fn(),
  }),
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
    { name: 'Write', description: 'write file', inputSchema: {} },
    { name: 'Append', description: 'append file', inputSchema: {} },
    { name: 'Bash', description: 'run command', inputSchema: {} },
    { name: 'Task', description: 'delegate task', inputSchema: {} },
  ],
}));

vi.mock('../../../src/main/tools/dispatch/toolDefinitions', () => ({
  getCoreToolDefinitions: vi.fn().mockReturnValue(mockToolDefinitions),
  getLoadedDeferredToolDefinitions: vi.fn().mockReturnValue([]),
  getAllToolDefinitions: vi.fn().mockReturnValue(mockToolDefinitions),
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
  needsArtifactTaskBrief: vi.fn((message: string) => /生成|html|game|write|create|build/i.test(message)),
}));

function buildCtx(overrides: Partial<ContextAssemblyCtx['runtime']> = {}): ContextAssemblyCtx {
  const onEvent = vi.fn();
  const inferenceMock = overrides.artifactRepairGuard
    ? vi.fn().mockResolvedValue({ type: 'text', content: 'recovered', finishReason: 'stop' })
    : vi.fn()
      .mockRejectedValueOnce(new Error('[Xiaomi] stream ended before [DONE] with tool calls; refusing to execute incomplete tool arguments'))
      .mockResolvedValueOnce({ type: 'text', content: 'recovered', finishReason: 'stop' });
  const modelRouter = {
    inference: inferenceMock,
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
    onEvent,
    abortController: null,
    lastStreamedContent: '',
    needsReinference: false,
    isInterrupted: false,
    isCancelled: false,
    effortLevel: 'medium',
    messages: [],
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
      { role: 'user', content: '生成一个单文件 HTML game' },
    ]),
    checkAndAutoCompress: vi.fn(),
  } as any;
}

describe('contextAssembly inference artifact retry', () => {
  // 这些用例通过 mock 掉的 modelRouter.inference 验证 inference.ts 的【引擎无关】编排逻辑
  // （artifact 重试 / repair-guard 注入 / vision fallback / 网络重试），断言也打在 modelRouter.inference 上。
  // 主 loop 默认引擎已翻成 aisdk（commit 65a61bab）后，runEngineInference 会绕过 modelRouter.inference
  // 走真实 inferenceViaAiSdk —— 'mock' 是测试夹具 provider，AI SDK 适配器解析不出 baseURL 直接崩，
  // 18 个用例齐挂。强制 legacy 引擎让 mock 重新生效；aisdk 派发本身由 aiSdkAdapter*.test.ts 覆盖。
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

  it('emits user-visible progress while waiting for artifact model output', async () => {
    const ctx = buildCtx();
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.taskProgress.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '正在生成 artifact 内容...',
    );
  });

  it('attaches tool strategy diagnostics with MCP selection to the model decision', async () => {
    const originalLength = mockToolDefinitions.length;
    mockToolDefinitions.push({
      name: 'mcp__github__search_code',
      description: 'search GitHub code',
      inputSchema: {},
      source: 'mcp',
      mcpServer: 'github',
    });
    try {
      const ctx = buildCtx();
      ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
        type: 'text',
        content: 'ok',
        finishReason: 'stop',
        usage: { inputTokens: 90, outputTokens: 12 },
      });

      const response = await inference(ctx);

      expect(response.runtimeDiagnostics?.toolStrategy).toMatchObject({
        visibleToolCount: 7,
        mcpToolCount: 1,
        mcpServerIds: ['github'],
        programmaticToolCalling: 'available',
        programmaticToolCount: 7,
        tokenSavings: {
          status: 'estimated',
          savedTokens: 35,
          detail: expect.stringContaining('真实账单以 provider usage 为准'),
          measurement: {
            savingsSource: 'tool-spec-local-estimate',
            usageSource: 'model-response-usage',
            providerReportedSavings: false,
          },
          basis: {
            source: 'tool-spec-local-estimate',
            toolCount: 7,
            previewToolCount: 7,
            fields: ['name', 'description', 'inputSchema'],
          },
          providerUsage: {
            source: 'model-response-usage',
            inputTokens: 90,
            outputTokens: 12,
            totalTokens: 102,
          },
        },
      });
      expect(response.runtimeDiagnostics?.modelDecision?.toolStrategy).toMatchObject({
        visibleToolCount: 7,
        mcpToolCount: 1,
        mcpServerIds: ['github'],
        tokenSavings: {
          status: 'estimated',
          savedTokens: 35,
          measurement: {
            savingsSource: 'tool-spec-local-estimate',
            usageSource: 'model-response-usage',
            providerReportedSavings: false,
          },
          basis: {
            source: 'tool-spec-local-estimate',
            toolCount: 7,
            previewToolCount: 7,
            fields: ['name', 'description', 'inputSchema'],
          },
          providerUsage: {
            source: 'model-response-usage',
            inputTokens: 90,
            outputTokens: 12,
            totalTokens: 102,
          },
        },
      });
    } finally {
      mockToolDefinitions.splice(originalLength);
    }
  });

  it('upgrades tool token savings when provider usage reports saved tokens', async () => {
    const ctx = buildCtx();
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
      usage: {
        inputTokens: 90,
        outputTokens: 12,
        providerReportedSavedTokens: 17,
      },
    });

    const response = await inference(ctx);

    expect(response.runtimeDiagnostics?.toolStrategy?.tokenSavings).toMatchObject({
      status: 'provider-reported',
      savedTokens: 17,
      detail: expect.stringContaining('provider 已回传 programmatic tool saved tokens'),
      measurement: {
        savingsSource: 'provider-reported',
        usageSource: 'model-response-usage',
        providerReportedSavings: true,
      },
      providerReport: {
        source: 'provider-reported',
        savedTokens: 17,
      },
      providerUsage: {
        source: 'model-response-usage',
        inputTokens: 90,
        outputTokens: 12,
        totalTokens: 102,
      },
    });
    expect(response.runtimeDiagnostics?.toolStrategy?.tokenSavings?.basis).toBeUndefined();
    expect(response.runtimeDiagnostics?.modelDecision?.toolStrategy?.tokenSavings).toMatchObject({
      status: 'provider-reported',
      savedTokens: 17,
      measurement: {
        savingsSource: 'provider-reported',
        usageSource: 'model-response-usage',
        providerReportedSavings: true,
      },
      providerReport: {
        source: 'provider-reported',
        savedTokens: 17,
      },
    });
  });

  it('aligns the final message model decision with the selected provider fallback', async () => {
    const ctx = buildCtx({
      modelConfig: {
        provider: 'moonshot',
        model: 'kimi-k2.5',
        apiKey: 'main-key',
        temperature: 0,
        maxTokens: 4096,
        adaptive: true,
      },
    });
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'fallback ok',
      finishReason: 'stop',
      actualProvider: 'deepseek',
      actualModel: 'deepseek-v4-flash',
      fallback: {
        from: { provider: 'moonshot', model: 'kimi-k2.5' },
        to: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      reason: 'Moonshot API error: 503 service unavailable',
      category: 'provider_unavailable',
      strategy: 'adaptive-provider-fallback',
      tried: [
          {
            provider: 'moonshot',
            model: 'kimi-k2.5',
            status: 'tried',
            reason: 'primary_failed',
            category: 'provider_unavailable',
          },
          {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            status: 'selected',
            reason: 'fallback_selected',
            category: 'provider_unavailable',
          },
        ],
      },
    });

    const response = await inference(ctx);

    expect(response.runtimeDiagnostics?.modelDecision).toMatchObject({
      requestedProvider: 'moonshot',
      requestedModel: 'kimi-k2.5',
      resolvedProvider: 'deepseek',
      resolvedModel: 'deepseek-v4-flash',
      reason: 'fallback-availability',
      fallbackFrom: 'moonshot/kimi-k2.5',
      speedPolicy: 'fallback-recovery',
      strategySummary: '原模型 moonshot/kimi-k2.5 不可用，切到 deepseek/deepseek-v4-flash 完成当前任务。',
      providerHealthSnapshot: {
        provider: 'deepseek',
        status: 'unknown',
      },
    });
  });

	  it('emits tool policy when capability fallback disables tools', async () => {
	    mockGetSettings.mockReturnValue({
	      models: {
	        providers: {
	          zhipu: {
	            enabled: true,
	            displayName: 'Zhipu Relay',
	            protocol: 'openai',
	            baseUrl: 'https://relay.example.com/zhipu/v1',
	          },
	        },
	      },
	    });
	    const ctx = buildCtx({
      modelConfig: {
        provider: 'mock',
        model: 'text-only',
        apiKey: 'mock-key',
        temperature: 0,
        maxTokens: 4096,
        adaptive: true,
      },
    });
    ctx.runtime.modelRouter.detectRequiredCapabilities.mockReturnValue(['vision']);
    ctx.runtime.modelRouter.getFallbackConfig.mockReturnValue({
      provider: 'zhipu',
      model: 'glm-4.5v',
      apiKey: 'fallback-key',
      maxTokens: 2048,
    });
    ctx.runtime.modelRouter.getModelInfo.mockImplementation((provider: string) => {
      if (provider === 'zhipu') {
        return { supportsVision: true, supportsTool: false, capabilities: ['vision'] };
      }
      return { supportsVision: false, supportsTool: true, capabilities: [] };
    });
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'vision answer',
      finishReason: 'stop',
    });
    ctx.buildModelMessages = vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: '请分析这张图片里的内容' },
    ]);

    const response = await inference(ctx);

    const fallbackEvents = ctx.runtime.onEvent.mock.calls
      .map(([event]: [{ type: string; data?: Record<string, unknown> }]) => event)
      .filter((event) => event.type === 'model_fallback');
    expect(fallbackEvents).toHaveLength(1);
    const fallbackEvent = fallbackEvents[fallbackEvents.length - 1];
    expect(fallbackEvent?.data).toMatchObject({
      reason: 'vision',
      from: 'mock/text-only',
      to: 'zhipu/glm-4.5v',
	      strategy: 'adaptive-capability-fallback',
	      toIdentity: {
	        provider: 'zhipu',
	        displayName: 'Zhipu Relay',
	        protocol: 'openai',
	        transportLabel: 'OpenAI-compatible',
	        endpoint: 'https://relay.example.com/zhipu/v1',
	      },
	      toolPolicy: {
        status: 'disabled',
        reason: 'fallback_model_without_tool_support',
        originalToolCount: 6,
        effectiveToolCount: 0,
        disabledToolNames: ['Read', 'Edit', 'Write', 'Append', 'Bash', 'Task'],
      },
    });
    const [, effectiveTools] = ctx.runtime.modelRouter.inference.mock.calls[0];
    expect(effectiveTools).toEqual([]);
    expect(response).toMatchObject({
      actualProvider: 'zhipu',
      actualModel: 'glm-4.5v',
      fallback: {
        from: { provider: 'mock', model: 'text-only' },
        to: { provider: 'zhipu', model: 'glm-4.5v' },
        category: 'capability',
        strategy: 'adaptive-capability-fallback',
      },
    });
    expect(response.runtimeDiagnostics?.modelDecision).toMatchObject({
      requestedProvider: 'mock',
      requestedModel: 'text-only',
      resolvedProvider: 'zhipu',
      resolvedModel: 'glm-4.5v',
      reason: 'capability-vision',
      fallbackFrom: 'mock/text-only',
      strategySummary: '原模型 mock/text-only 缺少 vision 能力，切到 zhipu/glm-4.5v 完成当前任务。',
      providerHealthSnapshot: {
        provider: 'zhipu',
        status: 'unknown',
      },
      toolPolicy: 'disabled-by-model',
    });
  });

  it('caps main inference output tokens with per-run inferenceOptions', async () => {
    const ctx = buildCtx({
      inferenceOptions: {
        maxOutputTokens: 128,
      },
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    const [, , config, , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(config.maxTokens).toBe(128);
    expect(options).toMatchObject({ maxOutputTokens: 128 });
  });

  it('fails before provider inference when the per-run input token budget is exceeded', async () => {
    const ctx = buildCtx({
      inferenceOptions: {
        maxInputTokens: 1,
      },
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'should not run',
      finishReason: 'stop',
    });

    await expect(inference(ctx)).rejects.toThrow(/input token budget exceeded before provider request/i);

    expect(ctx.runtime.modelRouter.inference).not.toHaveBeenCalled();
  });

  it('does not runtime-retry network failures when the per-run paid-smoke guard disables retries', async () => {
    const ctx = buildCtx({
      inferenceOptions: {
        disableRuntimeNetworkRetry: true,
      },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
      },
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockRejectedValueOnce(new Error('Network request failed: socket hang up'))
      .mockResolvedValueOnce({ type: 'text', content: 'should not retry', finishReason: 'stop' });
    ctx.inference = vi.fn(() => inference(ctx));

    await expect(inference(ctx)).rejects.toThrow(/socket hang up/);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    expect(ctx.inference).not.toHaveBeenCalled();
    expect(ctx.runtime._networkRetried).toBe(false);
  });

  it('emits repair-specific progress while waiting for artifact repair output', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'targeted_repair',
      },
    });

    await inference(ctx);

    expect(ctx.taskProgress.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '正在写入 artifact 修复补丁...',
    );
  });

  it('retries an artifact request once with non-streaming when streamed tool arguments end incomplete', async () => {
    const ctx = buildCtx();

    const result = await inference(ctx);

    expect(result).toMatchObject({ type: 'text', content: 'recovered', finishReason: 'stop' });
    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(2);
    expect(ctx.runtime.modelRouter.inference).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining(ctx.runtime.modelConfig),
      undefined,
      undefined,
      { forceNonStreaming: true, disableProviderTransientRetry: true },
    );
    expect(ctx.runtime.onEvent).toHaveBeenCalledWith({
      type: 'notification',
      data: {
        message: '生成文件时模型流中断，正在切换到更稳的非流式方式重试。',
      },
    });
    expect(ctx.taskProgress.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '模型流中断，正在用非流式方式重试 artifact 生成...',
    );
    expect(ctx.runtime._artifactNonStreamingRetried).toBe(false);
  });

  it('uses same-provider vision fallback as preflight, then keeps the main model for answering', async () => {
    mockGetApiKey.mockReturnValue('');
    const ctx = buildCtx({
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'current-xiaomi-key',
        temperature: 0,
        maxTokens: 131072,
        // adaptive=true 才会启用 capability fallback（含 vision 预处理）。
        // 自 fabfd751(2026-05-22) 起，显式模型不再自动 fallback；本用例测的就是预处理
        // 路径，必须显式开 adaptive，否则 preflight 被跳过、只剩 1 次主模型调用。
        adaptive: true,
      },
    } as any);
    ctx.buildModelMessages = vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'base64data',
            },
          },
        ],
      },
    ]);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockResolvedValueOnce({
        type: 'text',
        content: '图片里是一个应用截图。',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        type: 'text',
        content: 'ok',
        finishReason: 'stop',
      });
    ctx.runtime.modelRouter.detectRequiredCapabilities = vi.fn().mockReturnValue(['vision']);
    ctx.runtime.modelRouter.getModelInfo = vi.fn()
      .mockReturnValueOnce({ supportsVision: false, supportsTool: true, capabilities: ['general'] })
      .mockReturnValueOnce({ supportsVision: true, supportsTool: true, capabilities: ['general', 'vision'] });
    ctx.runtime.modelRouter.getFallbackConfig = vi.fn().mockReturnValue({
      provider: 'xiaomi',
      model: 'mimo-v2-omni',
      apiKey: 'current-xiaomi-key',
      maxTokens: 131072,
    });
    ctx.runtime.modelRouter.getVisionPreflightCandidates = vi.fn().mockReturnValue([{
      provider: 'xiaomi',
      model: 'mimo-v2-omni',
      apiKey: 'current-xiaomi-key',
      maxTokens: 131072,
    }]);

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(2);
    const [preflightMessages, preflightTools, preflightConfig] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(preflightTools).toEqual([]);
    expect(preflightConfig).toMatchObject({
      provider: 'xiaomi',
      model: 'mimo-v2-omni',
      apiKey: 'current-xiaomi-key',
    });
    expect(JSON.stringify(preflightMessages)).toContain('请把图片内容整理成给主模型使用的事实摘要');

    const [mainMessages, , mainConfig] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[1];
    expect(mainConfig).toMatchObject({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      apiKey: 'current-xiaomi-key',
    });
    expect(JSON.stringify(mainMessages)).toContain('[视觉预处理结果]');
    expect(JSON.stringify(mainMessages)).toContain('图片里是一个应用截图。');
    expect(JSON.stringify(mainMessages)).not.toContain('"type":"image"');
    expect(ctx.runtime.onEvent).toHaveBeenCalledWith({
      type: 'notification',
      data: {
        message: '已用视觉模型 mimo-v2-omni 读取图片，继续由 mimo-v2.5-pro 回答。',
      },
    });
  });

  it('narrows visible tools during artifact repair mode before a patch exists', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    // Route A: repair mode is always write-priority — the goal is to patch.
    expect(options).toMatchObject({ artifactRepairActive: true, artifactRepairWritePriority: true });
  });

  it('allows validation Bash during artifact repair after a patch exists', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
        patched: true,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    // Route A: post-patch keeps Read alongside the mutation tools and adds Bash.
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
  });

  it('seeds artifact repair guard before the first inference from a repair request', async () => {
    const ctx = buildCtx({
      messages: [
        {
          id: 'user-repair',
          role: 'user',
          content: '修复 /tmp/game.html 这个 HTML 游戏，当前 validator failed: runSmokeTest reachability progressPlan 未通过。',
          timestamp: Date.now(),
        },
      ],
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.runtime.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/game.html',
      phase: 'initial_repair',
      patched: false,
    });
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
  });

  it('does not seed artifact repair guard for fresh generation requests that mention the test contract', async () => {
    const ctx = buildCtx({
      messages: [
        {
          id: 'user-create',
          role: 'user',
          content: 'Create a single-file browser game at corgi-platformer.html. Include window.__GAME_TEST__ with reset(), step(), getState(), and runSmokeTest().',
          timestamp: Date.now(),
        },
      ],
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.runtime.artifactRepairGuard).toBeUndefined();
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash', 'Task']);
    expect(options).toMatchObject({ artifactRepairActive: false });
    expect(ctx.taskProgress.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '正在生成 artifact 内容...',
    );
  });

  it('does not seed artifact repair guard from stale persistent context during fresh generation', async () => {
    const ctx = buildCtx({
      messages: [
        {
          id: 'user-create-stale-context',
          role: 'user',
          content: [
            'Create a complete single-file browser platformer game at /private/tmp/new-game.html.',
            'Include machine-checkable game validation with window.__GAME_TEST__.',
            'Do not use test-only direct state grants or existence-only coverage.',
          ].join(' '),
          timestamp: Date.now(),
        },
      ],
      persistentSystemContext: [
        '修复 /private/tmp/code-agent-hard-fail-game.html 这个已经存在的单文件 HTML 互动游戏。当前 validator 失败摘要：runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据。',
      ],
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.runtime.artifactRepairGuard).toBeUndefined();
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash', 'Task']);
    expect(options).toMatchObject({ artifactRepairActive: false });
  });

  it('seeds active repair issue codes before the first inference from validator failure text', async () => {
    const ctx = buildCtx({
      messages: [
        {
          id: 'user-repair-coverage',
          role: 'user',
          content: [
            '修复 /tmp/game.html 这个 HTML 游戏。',
            '当前 validator 失败摘要：',
            'runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。',
          ].join('\n'),
          timestamp: Date.now(),
        },
      ],
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.runtime.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/game.html',
      phase: 'initial_repair',
      activeIssueCodes: ['coverage_without_runtime_evidence'],
    });
    const [, tools, config, , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(config.maxTokens).toBe(4096);
    expect(options?.artifactRepairActive).toBe(true);
    // Route A: repair mode is always write-priority.
    expect(options?.artifactRepairWritePriority).toBe(true);
  });

  it('seeds playability repair mode from user-visible interaction failures', async () => {
    const ctx = buildCtx({
      messages: [
        {
          id: 'user-playability-repair',
          role: 'user',
          content: '修复 /tmp/game.html 这个 HTML 游戏，现在台阶没法上去，能力道具拿不到，交互玩不通。',
          timestamp: Date.now(),
        },
      ],
    } as any);
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.runtime.artifactRepairGuard).toMatchObject({
      targetFile: '/tmp/game.html',
      phase: 'playability_repair',
      patched: false,
    });
  });

  it('removes Bash after the first repair-guard block', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
  });

  it('keeps the full repair tool set available regardless of attempt count (Route A)', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 3,
        phase: 'targeted_repair',
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: true,
    });
  });

  it('caps artifact repair max tokens to the full-rewrite ceiling (Route A)', async () => {
    const ctx = buildCtx({
      modelConfig: {
        provider: 'mock',
        model: 'test-model',
        apiKey: 'mock-key',
        temperature: 0,
        maxTokens: 131072,
      },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 0,
        phase: 'playability_repair',
      },
    } as any);

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, , config, , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    // Route A: repair is always write-priority, so an oversized maxTokens is capped
    // to the full-rewrite ceiling (the model may need to Write a whole HTML file).
    expect(config.maxTokens).toBe(65536);
    expect(options).toMatchObject({ artifactRepairActive: true, artifactRepairWritePriority: true });
  });

  it('keeps Read visible after soft-blocks when the target file has not been read successfully', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'initial_repair',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: true,
    });
  });

  it('allows one network retry during artifact repair before giving up', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
      },
    });
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockRejectedValueOnce(new Error('Network request failed: socket hang up'))
      .mockResolvedValueOnce({ type: 'text', content: 'recovered', finishReason: 'stop' });
    ctx.inference = vi.fn(() => inference(ctx));

    const result = await inference(ctx);

    expect(result).toMatchObject({ type: 'text', content: 'recovered', finishReason: 'stop' });
    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(2);
    expect(ctx.inference).toHaveBeenCalledTimes(1);
    expect(ctx.runtime._networkRetried).toBe(false);
    expect(ctx.runtime._networkRetryCount).toBe(0);
  });

  it('retries artifact repair write-priority timeout once with compact repair context', async () => {
    const ctx = buildCtx({
      modelConfig: {
        provider: 'mock',
        model: 'test-model',
        apiKey: 'mock-key',
        temperature: 0,
        maxTokens: 131072,
      },
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'initial_repair',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    } as any);
    ctx.buildModelMessages = vi.fn().mockResolvedValue([
      { role: 'system', content: '<artifact-validation-failed>coverage_without_runtime_evidence</artifact-validation-failed>' },
      { role: 'user', content: 'fix /tmp/game.html' },
      {
        role: 'tool',
        content: [
          '<artifact-repair-file-read>',
          'window.__GAME_TEST__ = {',
          '  runSmokeTest() { mechanics.add("enemy"); }',
          '};',
          'function update() { Player.update(1, platforms); }',
          '</artifact-repair-file-read>',
        ].join('\n'),
      },
    ]);
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockRejectedValueOnce(new Error('xiaomi request timeout after 180000ms'))
      .mockResolvedValueOnce({
        type: 'tool_use',
        content: '',
        toolCalls: [
          { id: 'edit-1', name: 'Edit', arguments: { file_path: '/tmp/game.html', edits: [] } },
        ],
        finishReason: 'tool_calls',
      });

    const result = await inference(ctx);

    expect(result).toMatchObject({
      type: 'tool_use',
      runtimeDiagnostics: expect.objectContaining({ artifactRepairCompactWriteRetry: true }),
    });
    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(2);
    const [, retryTools, retryConfig, retryStream, , retryOptions] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[1];
    // Route A: the repair tool set stays full (Read/Edit/Write/Append) on the retry too.
    expect(retryTools.map((tool: { name: string }) => tool.name)).toEqual(['Read', 'Edit', 'Write', 'Append', 'Bash']);
    expect(retryConfig.maxTokens).toBe(8192);
    expect(retryStream).toBeUndefined();
    expect(retryOptions).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      forceNonStreaming: true,
      requestTimeoutMs: 90000,
    });
    const [retryMessages] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[1];
    expect(retryMessages[0].content).toContain('<artifact-repair-compact-write-retry>');
    expect(retryMessages[0].content).toContain('direct plain object literal');
    expect(retryMessages[0].content).toContain('390px mobile viewport');
    expect(retryMessages.map((message: any) => message.content).join('\n')).toContain('window.__GAME_TEST__');
    expect(ctx.runtime._artifactRepairCompactWriteRetried).toBe(false);
  });

  it('allows a second artifact repair retry for fast TLS connection failures', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'initial_repair',
      },
    });
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockRejectedValueOnce(new Error('Network request failed: Client network socket disconnected before secure TLS connection was established'))
      .mockRejectedValueOnce(new Error('Network request failed: Client network socket disconnected before secure TLS connection was established'))
      .mockResolvedValueOnce({ type: 'text', content: 'recovered', finishReason: 'stop' });
    ctx.inference = vi.fn(() => inference(ctx));

    const result = await inference(ctx);

    expect(result).toMatchObject({ type: 'text', content: 'recovered', finishReason: 'stop' });
    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(3);
    expect(ctx.inference).toHaveBeenCalledTimes(2);
    expect(ctx.runtime._networkRetried).toBe(false);
    expect(ctx.runtime._networkRetryCount).toBe(0);
  });
});
