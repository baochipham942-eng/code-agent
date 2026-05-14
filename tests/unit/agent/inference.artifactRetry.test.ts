import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/main/agent/runtime/contextAssembly';
import { inference } from '../../../src/main/agent/runtime/contextAssembly/inference';

const { mockGetApiKey } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services', () => ({
  getConfigService: () => ({ getApiKey: mockGetApiKey }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({
    startGenerationInSpan: vi.fn(),
    endGeneration: vi.fn(),
  }),
}));

vi.mock('../../../src/main/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
  },
}));

const { mockToolDefinitions } = vi.hoisted(() => ({
  mockToolDefinitions: [
    { name: 'Read', description: 'read file', input_schema: {} },
    { name: 'Edit', description: 'edit file', input_schema: {} },
    { name: 'Write', description: 'write file', input_schema: {} },
    { name: 'Append', description: 'append file', input_schema: {} },
    { name: 'Bash', description: 'run command', input_schema: {} },
    { name: 'Task', description: 'delegate task', input_schema: {} },
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
    runFinalizer: {
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKey.mockReturnValue('mock-key');
  });

  it('emits user-visible progress while waiting for artifact model output', async () => {
    const ctx = buildCtx();
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'ok',
      finishReason: 'stop',
    });

    await inference(ctx);

    expect(ctx.runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '正在生成 artifact 内容...',
    );
  });

  it('emits repair-specific progress while waiting for artifact repair output', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'targeted_repair',
        targetReadCount: 1,
        noOpPatchCount: 1,
      },
    });

    await inference(ctx);

    expect(ctx.runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
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
    expect(ctx.runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'generating',
      '模型流中断，正在用非流式方式重试 artifact 生成...',
    );
    expect(ctx.runtime._artifactNonStreamingRetried).toBe(false);
  });

  it('reuses the current provider key for same-provider vision fallback', async () => {
    mockGetApiKey.mockReturnValue('');
    const ctx = buildCtx({
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'current-xiaomi-key',
        temperature: 0,
        maxTokens: 131072,
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
    ctx.runtime.modelRouter.inference = vi.fn().mockResolvedValue({
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

    await inference(ctx);

    const [, , effectiveConfig] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(effectiveConfig).toMatchObject({
      provider: 'xiaomi',
      model: 'mimo-v2-omni',
      apiKey: 'current-xiaomi-key',
    });
    expect(ctx.runtime.onEvent).toHaveBeenCalledWith({
      type: 'model_fallback',
      data: {
        reason: 'vision',
        from: 'mimo-v2.5-pro',
        to: 'mimo-v2-omni',
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
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append']);
    expect(options).toMatchObject({ artifactRepairActive: true, artifactRepairWritePriority: false });
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
    expect(toolNames).toEqual(['Edit', 'Write', 'Append', 'Bash']);
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
      targetReadCount: 0,
      patched: false,
    });
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append']);
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
    expect(ctx.runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
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
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['Read', 'Edit', 'Write', 'Append']);
    expect(config.maxTokens).toBe(4096);
    expect(options?.artifactRepairActive).toBe(true);
    expect(options?.artifactRepairWritePriority).toBe(false);
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
      targetReadCount: 0,
      patched: false,
    });
  });

  it('removes Bash after the first repair-guard block', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
        blockedToolCount: 1,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append']);
  });

  it('forces mutation-only tools after repeated repair-guard blocks', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 3,
        phase: 'targeted_repair',
        targetReadCount: 1,
        blockedToolCount: 2,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
  });

  it('keeps Read available after repeated blocks if the target file was never read', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 3,
        phase: 'targeted_repair',
        targetReadCount: 0,
        blockedToolCount: 2,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: false,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('removes Read once the repair read budget is exhausted', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 0,
        phase: 'initial_repair',
        targetReadCount: 10,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    const [, , , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('keeps one ranged Read visible for targeted contract repair after the full target read', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 0,
        phase: 'initial_repair',
        targetReadCount: 10,
        targetRangedReadCount: 0,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Append']);
    expect(options).toMatchObject({ artifactRepairActive: true, artifactRepairWritePriority: false });
  });

  it('keeps a second ranged Read visible for coverage evidence repairs', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 0,
        phase: 'initial_repair',
        targetReadCount: 10,
        targetRangedReadCount: 1,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Append']);
    expect(options).toMatchObject({ artifactRepairActive: true, artifactRepairWritePriority: false });
  });

  it('removes Read after the second targeted ranged anchor read is exhausted', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 0,
        phase: 'initial_repair',
        targetReadCount: 10,
        targetRangedReadCount: 4,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('keeps metadata repairs on targeted Edit after the anchor read is exhausted', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 0,
        phase: 'initial_repair',
        targetReadCount: 10,
        targetRangedReadCount: 3,
        activeIssueCodes: ['missing_quality_metadata'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('uses write-priority artifact repair inference once a ranged target read is exhausted', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'targeted_repair',
        targetReadCount: 10,
        targetRangedReadCount: 1,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('uses write-priority after targeted issue reads are exhausted', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'targeted_repair',
        targetReadCount: 10,
        targetRangedReadCount: 4,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('exposes a targeted Read after validation failure seeds the full read budget', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        targetReadCount: 10,
        targetRangedReadCount: 0,
        blockedToolCount: 2,
        noOpPatchCount: 1,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: false,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('uses write-priority artifact repair inference after repeated repair-guard blocks', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
        targetReadCount: 10,
        blockedToolCount: 2,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('caps artifact repair recovery max tokens before write-priority is needed', async () => {
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
        targetReadCount: 0,
      },
    } as any);

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, , config, , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(config.maxTokens).toBe(16384);
    expect(options).toMatchObject({ artifactRepairActive: true, artifactRepairWritePriority: false });
  });

  it('caps targeted artifact repair edit-priority max tokens below full rewrite size', async () => {
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
        attempts: 1,
        phase: 'baseline_repair',
        targetReadCount: 1,
        noOpPatchCount: 1,
      },
    } as any);

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, , config, , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(config.maxTokens).toBe(32768);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('removes reads after a no-op repair patch while keeping mutation tools', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        targetReadCount: 1,
        noOpPatchCount: 1,
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    const [, , , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('exposes a targeted Read after an Edit anchor failure so the next patch can use exact context', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        targetReadCount: 1,
        blockedToolCount: 2,
        editAnchorFailureCount: 1,
        preferTargetedEdit: true,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: false,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('switches to mutation priority after an Edit anchor failure once the ranged read is spent', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
        targetReadCount: 10,
        targetRangedReadCount: 3,
        blockedToolCount: 3,
        editAnchorFailureCount: 1,
        preferTargetedEdit: true,
        activeIssueCodes: ['missing_reachability_metadata', 'run_smoke_failed'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Edit', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: true,
      artifactRepairFullRewritePriority: false,
    });
  });

  it('keeps Read visible after soft-blocks when the target file has not been read successfully', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'initial_repair',
        targetReadCount: 0,
        targetRangedReadCount: 1,
        blockedToolCount: 1,
        noOpPatchCount: 1,
        preferTargetedEdit: true,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });

    await inference(ctx);

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    const [, tools, , , , options] = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(['Read', 'Edit', 'Write', 'Append']);
    expect(options).toMatchObject({
      artifactRepairActive: true,
      artifactRepairWritePriority: false,
      artifactRepairFullRewritePriority: false,
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

  it('does not retry slow provider request timeouts during artifact repair', async () => {
    const ctx = buildCtx({
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 2,
        phase: 'targeted_repair',
      },
    });
    ctx.runtime.modelRouter.inference = vi.fn()
      .mockRejectedValueOnce(new Error('xiaomi request timeout after 90000ms'));
    ctx.inference = vi.fn(() => inference(ctx));

    await expect(inference(ctx)).rejects.toThrow('xiaomi request timeout after 90000ms');

    expect(ctx.runtime.modelRouter.inference).toHaveBeenCalledTimes(1);
    expect(ctx.inference).not.toHaveBeenCalled();
  });

  it('retries artifact repair write-priority timeout once with compact mutation-only context', async () => {
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
        targetReadCount: 10,
        targetRangedReadCount: 4,
        noOpPatchCount: 1,
        preferTargetedEdit: true,
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
    expect(retryTools.map((tool: { name: string }) => tool.name)).toEqual(['Edit', 'Append']);
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
