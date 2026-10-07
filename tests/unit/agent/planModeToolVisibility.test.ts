// Hermetic tool-table probe: the mocked modelRouter sees the exact definitions
// inference would hand to a provider. No model or network call is made.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import { inference } from '../../../src/host/agent/runtime/contextAssembly/inference';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { ModelConfig, ModelProviderProtocol } from '../../../src/shared/contract/model';
import type { ToolDefinition } from '../../../src/shared/contract';

const { mockGetApiKey, mockRecordUsage, mockCheckBudget } = vi.hoisted(() => ({
  mockGetApiKey: vi.fn(() => 'mock-key'),
  mockRecordUsage: vi.fn(),
  mockCheckBudget: vi.fn(() => ({ alertLevel: 'none', usagePercentage: 0 })),
}));

vi.mock('../../../src/host/telemetry/contentCache', () => ({
  getContentCache: () => ({ store: vi.fn(() => true), get: vi.fn(() => null) }),
}));
vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ get: () => null, store: vi.fn() }),
}));
vi.mock('../../../src/host/telemetry/toolSchemaCache', () => ({
  getToolSchemaCache: () => ({ store: vi.fn(() => true), get: vi.fn(() => null) }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: mockGetApiKey }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({ startGenerationInSpan: vi.fn(), endGeneration: vi.fn() }),
  getBudgetService: () => ({ recordUsage: mockRecordUsage, checkBudget: mockCheckBudget }),
  BudgetAlertLevel: { NONE: 'none', SILENT: 'silent', WARNING: 'warning', BLOCKED: 'blocked' },
}));
vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));
vi.mock('../../../src/host/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/mcp')>();
  return { ...actual, getMCPClient: () => ({ getToolDefinitions: () => [] }) };
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
  logCollector: { agent: vi.fn(), browser: vi.fn() },
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

interface ProviderShape {
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly protocol?: ModelProviderProtocol;
}

const PROVIDERS: readonly ProviderShape[] = [
  { label: 'built-in openai', provider: 'openai', model: 'gpt-test' },
  { label: 'custom OpenAI-compatible', provider: 'custom-stepfun', model: 'step-3.5-flash-2603', protocol: 'openai' },
  { label: 'custom claude-protocol', provider: 'custom-claude', model: 'claude-compatible', protocol: 'claude' },
];

function buildCtx(provider: ProviderShape, enableToolDeferredLoading: boolean): ContextAssemblyCtx {
  const modelRouter = {
    inference: vi.fn().mockResolvedValue({ type: 'text', content: 'single', finishReason: 'stop' }),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    getModelInfo: vi.fn().mockReturnValue({ supportsVision: true, supportsTool: true, capabilities: ['general'] }),
    getFallbackConfig: vi.fn().mockReturnValue(null),
    getVisionPreflightCandidates: vi.fn().mockReturnValue([]),
  };

  const modelConfig: ModelConfig = {
    provider: provider.provider,
    model: provider.model,
    ...(provider.protocol ? { protocol: provider.protocol } : {}),
    apiKey: 'mock-key',
    temperature: 0,
    maxTokens: 4096,
  };

  const runtime = {
    enableToolDeferredLoading,
    cachePromptSample: {},
    toolScope: undefined,
    stats: RunStatsState.forTest({ traceId: 'trace-plan-mode' } as never),
    turn: TurnState.forTest({ currentIterationSpanId: 'span-1', currentTurnId: 'turn-1', effortLevel: 'medium' }),
    sessionId: `session-${provider.provider}`,
    workingDirectory: '/tmp',
    modelConfig,
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
    taskProgress: { emitTaskProgress: vi.fn() } as any,
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

function hasPlanMode(ctx: ContextAssemblyCtx): boolean {
  return sentTools(ctx).some((tool) => tool.name === 'PlanMode');
}

describe('PlanMode model-visible tool table', () => {
  const previousEngine = process.env.CODE_AGENT_MODEL_ENGINE;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKey.mockReturnValue('mock-key');
    resetProtocolRegistry();
    resetToolSearchService();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  afterEach(() => {
    resetToolSearchService();
    if (previousEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = previousEngine;
  });

  it.each(PROVIDERS)('deferred loading on, plain turn: $label records PlanMode as absent', async (provider) => {
    const ctx = buildCtx(provider, true);
    await inference(ctx);
    expect(hasPlanMode(ctx)).toBe(false);
  });

  it.each(PROVIDERS)('ToolSearch select:PlanMode makes PlanMode visible: $label', async (provider) => {
    const selected = getToolSearchService().selectTool('PlanMode');
    expect(selected.loadedTools).toEqual(['PlanMode']);

    const ctx = buildCtx(provider, true);
    await inference(ctx);
    expect(hasPlanMode(ctx)).toBe(true);
  });

  it.each(PROVIDERS)('deferred loading off keeps PlanMode visible: $label', async (provider) => {
    const ctx = buildCtx(provider, false);
    await inference(ctx);
    expect(hasPlanMode(ctx)).toBe(true);
  });
});
