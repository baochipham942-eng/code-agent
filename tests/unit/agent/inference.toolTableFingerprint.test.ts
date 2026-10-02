// 延迟加载打开时，inference 发给引擎的工具表就是缓存前缀的一部分。
// 两次调用之间用 ToolSearch 加载一个延迟工具，指纹必须跟着变；不加载则工具表和指纹都不变。
// harness 对齐 inference.maxMode.test.ts：legacy 引擎，断言打在 modelRouter.inference 的 tools 参数上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import { inference } from '../../../src/host/agent/runtime/contextAssembly/inference';
import { fingerprintToolTable, type CachePromptSampleHolder } from '../../../src/host/agent/runtime/toolTableFingerprint';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { ToolDefinition } from '../../../src/shared/contract';

const { mockGetApiKey, mockRecordUsage, mockCheckBudget } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockRecordUsage: vi.fn(),
  mockCheckBudget: vi.fn(() => ({ alertLevel: 'none', usagePercentage: 0 })),
}));

const replayCaches = vi.hoisted(() => ({
  content: new Map<string, string>(),
  tools: new Map<string, string>(),
}));

vi.mock('../../../src/host/telemetry/contentCache', () => ({
  getContentCache: () => ({
    store: (hash: string, content: string) => (replayCaches.content.set(hash, content), true),
    get: (hash: string) => replayCaches.content.get(hash) ?? null,
  }),
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ get: () => null, store: vi.fn() }),
}));

vi.mock('../../../src/host/telemetry/toolSchemaCache', () => ({
  getToolSchemaCache: () => ({
    store: (hash: string, content: string) => (replayCaches.tools.set(hash, content), true),
    get: (hash: string) => replayCaches.tools.get(hash) ?? null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
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

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: mockGetApiKey }),
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

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/mcp')>();
  return {
    ...actual,
    getMCPClient: () => ({
      getToolDefinitions: () => [],
    }),
  };
});

vi.mock('../../../src/host/services/core/configService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/configService')>();
  return {
    ...actual,
    getConfigService: () => ({
      onSettingsUpdated: vi.fn(),
      getApiKey: () => 'mock-key',
      getServiceApiKey: () => undefined,
      getSettings: () => ({}),
    }),
  };
});

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    browser: vi.fn(),
  },
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
  needsArtifactTaskBrief: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => ({
    hasDurableOwner: () => true,
    checkpointNativeModelOperation: vi.fn(async () => {}),
  }),
}));

function buildCtx(holder: CachePromptSampleHolder): ContextAssemblyCtx {
  const modelRouter = {
    inference: vi.fn().mockResolvedValue({ type: 'text', content: 'single', finishReason: 'stop' }),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    getModelInfo: vi.fn().mockReturnValue({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: vi.fn().mockReturnValue(null),
    getVisionPreflightCandidates: vi.fn().mockReturnValue([]),
  };

  const runtime = {
    enableToolDeferredLoading: true,
    cachePromptSample: holder,
    toolScope: undefined,
    stats: RunStatsState.forTest({ traceId: 'trace-tools' } as never),
    turn: TurnState.forTest({ currentIterationSpanId: 'span-1', currentTurnId: 'turn-1', effortLevel: 'medium' }),
    sessionId: 'session-tools',
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
    control: ControlState.forTest(),
    contextHealth: ContextHealthState.forTest(),
    messages: [],
    turnTrace: { record: vi.fn() },
    maxMode: false,
    artifact: ArtifactState.forTest(),
  } as any;

  return {
    runtime,
    inferenceRecovery: {
      _contextOverflowRetried: false,
      _artifactNonStreamingRetried: false,
      _artifactRepairCompactWriteRetried: false,
      _networkRetried: false,
    },
    taskProgress: {
      emitTaskProgress: vi.fn(),
    } as any,
    recordTokenUsage: vi.fn(),
    inference: vi.fn(),
    buildModelMessages: vi.fn().mockResolvedValue([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'status check' },
    ]),
    checkAndAutoCompress: vi.fn(),
  } as any;
}

function sentTools(ctx: ContextAssemblyCtx): ToolDefinition[] {
  const tools = vi.mocked(ctx.runtime.modelRouter.inference).mock.calls[0]?.[1];
  if (!Array.isArray(tools)) throw new Error('modelRouter.inference was not called with a tools array');
  return tools as ToolDefinition[];
}

function assertOnlyAdded(before: readonly ToolDefinition[], after: readonly ToolDefinition[], name: string): void {
  const beforeByName = new Map(before.map((tool) => [tool.name, tool]));
  const afterByName = new Map(after.map((tool) => [tool.name, tool]));
  expect([...afterByName.keys()].filter((key) => !beforeByName.has(key))).toEqual([name]);
  expect([...beforeByName.keys()].filter((key) => !afterByName.has(key))).toEqual([]);
  for (const [key, tool] of beforeByName) {
    expect(afterByName.get(key)).toEqual(tool);
  }
}

describe('inference tool table fingerprint', () => {
  const prevEngine = process.env.CODE_AGENT_MODEL_ENGINE;

  beforeEach(() => {
    vi.clearAllMocks();
    replayCaches.content.clear();
    replayCaches.tools.clear();
    mockGetApiKey.mockReturnValue('mock-key');
    resetProtocolRegistry();
    resetToolSearchService();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  afterEach(() => {
    resetToolSearchService();
    if (prevEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = prevEngine;
  });

  it('stores a different fingerprint after one deferred tool is loaded', async () => {
    const holder: CachePromptSampleHolder = {};
    const first = buildCtx(holder);
    await inference(first);
    const before = sentTools(first);
    const beforeFingerprint = holder.toolsFingerprint;
    expect(before.length).toBeGreaterThan(0);
    expect(beforeFingerprint).toBe(fingerprintToolTable(before));
    expect(before.map((tool) => tool.name)).not.toContain('Append');

    const loaded = getToolSearchService().selectTool('Append');
    expect(loaded.loadedTools).toEqual(['Append']);

    const second = buildCtx(holder);
    await inference(second);
    const after = sentTools(second);

    assertOnlyAdded(before, after, 'Append');
    expect(holder.toolsFingerprint).toBe(fingerprintToolTable(after));
    expect(holder.toolsFingerprint).not.toBe(beforeFingerprint);
  });

  it('keeps the tools array and fingerprint identical when nothing is loaded between calls', async () => {
    const holder: CachePromptSampleHolder = {};
    const first = buildCtx(holder);
    await inference(first);
    const before = sentTools(first);
    const beforeFingerprint = holder.toolsFingerprint;

    const second = buildCtx(holder);
    await inference(second);
    const after = sentTools(second);

    expect(after).toEqual(before);
    expect(holder.toolsFingerprint).toBe(beforeFingerprint);
    expect(holder.toolsFingerprint).toBe(fingerprintToolTable(after));
  });
});
