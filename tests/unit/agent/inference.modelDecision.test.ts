// ============================================================================
// ADR-019 批 3：model_decision 事件透传 — 主聊天决策发射
//
// resolveMainChatModelDecision 是 runEngineInference 的统一决策点：
// 计算单一入口决策（计费门控 + 执行层 API key 校验）→ 通过 ctx.runtime.onEvent
// 发射 model_decision 事件（web SSE / 桌面 IPC 双路径共用同一 onEvent）→
// 返回 adaptive 简单任务路由后的执行配置。
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import type { ModelConfig } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/host/agent/loopTypes';
import { DEFAULT_MODELS } from '../../../src/shared/constants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

// --------------------------------------------------------------------------
// Mocks（与 inference.artifactRetry.test.ts 同一套，保证 inference.ts 可导入）
// --------------------------------------------------------------------------

const { mockAiSdkSupportsProvider, mockGetApiKey, mockGetProviderHealth, mockGetSettings, mockInferenceViaAiSdk } = vi.hoisted(() => ({
  mockAiSdkSupportsProvider: vi.fn((_provider: string) => true),
  mockGetApiKey: vi.fn<(provider: string) => string | null>(() => 'mock-key'),
  mockGetProviderHealth: vi.fn((_provider: string) => null),
  mockGetSettings: vi.fn(() => ({} as Record<string, unknown>)),
  mockInferenceViaAiSdk: vi.fn(),
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
  getConfigService: () => ({ getApiKey: mockGetApiKey, getSettings: mockGetSettings }),
  getAuthService: () => ({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) }),
  getLangfuseService: () => ({
    startGenerationInSpan: vi.fn(),
    endGeneration: vi.fn(),
  }),
}));

// modelDecision.ts 直接 import configService（绕过 services barrel），需单独 mock
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: mockGetApiKey, getSettings: mockGetSettings }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    browser: vi.fn(),
  },
}));

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getCoreToolDefinitions: vi.fn().mockReturnValue([]),
  getLoadedDeferredToolDefinitions: vi.fn().mockReturnValue([]),
  getAllToolDefinitions: vi.fn().mockReturnValue([]),
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

vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({
  aiSdkSupportsProvider: mockAiSdkSupportsProvider,
  inferenceViaAiSdk: mockInferenceViaAiSdk,
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({
    getHealth: mockGetProviderHealth,
  }),
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  needsArtifactTaskBrief: vi.fn(() => false),
}));

import {
  buildAiSdkAdaptiveFallbackInfo,
  resolveMainChatModelDecision,
  runAiSdkInferenceWithProviderFallback,
} from '../../../src/host/agent/runtime/contextAssembly/inference';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const SIMPLE_MESSAGES: ModelMessage[] = [{ role: 'user', content: '你好' }];
const COMPLEX_MESSAGES: ModelMessage[] = [{
  role: 'user',
  content: '帮我重构这个项目的认证模块，需要考虑架构设计和向后兼容，涉及 auth.ts、session.ts、middleware.ts 三个文件的迁移，' +
    '```typescript\nexport function login() {}\n```\n```typescript\nexport function logout() {}\n```',
}];

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'moonshot',
    model: 'kimi-k2.5',
    apiKey: 'main-key',
    temperature: 0.7,
    maxTokens: 8192,
    ...overrides,
  } as ModelConfig;
}

function makeCtx(): ContextAssemblyCtx {
  const onEvent = vi.fn();
  return {
    runtime: {
      onEvent,
      currentTurnId: 'turn-42',
      sessionId: 'session-1',
      modelConfig: makeConfig(),
    },
    inferenceRecovery: {
      _contextOverflowRetried: false,
      _artifactNonStreamingRetried: false,
      _artifactRepairCompactWriteRetried: false,
      _networkRetried: false,
    },
  } as unknown as ContextAssemblyCtx;
}

function getDecisionEvents(ctx: ContextAssemblyCtx) {
  return (ctx.runtime.onEvent as ReturnType<typeof vi.fn>).mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'model_decision');
}

beforeEach(() => {
  mockAiSdkSupportsProvider.mockReset();
  mockAiSdkSupportsProvider.mockReturnValue(true);
  mockGetApiKey.mockReset();
  mockGetApiKey.mockReturnValue('mock-key');
  mockGetProviderHealth.mockReset();
  mockGetProviderHealth.mockReturnValue(null);
  mockGetSettings.mockReset();
  mockGetSettings.mockReturnValue({});
  mockInferenceViaAiSdk.mockReset();
});

// --------------------------------------------------------------------------
// 1. 决策事件发射
// --------------------------------------------------------------------------

describe('resolveMainChatModelDecision — model_decision 事件发射（ADR-019 批 3）', () => {
  it('adaptive 关闭时发射 user-selected 决策且不切换配置', () => {
    const ctx = makeCtx();
    const result = resolveMainChatModelDecision(ctx, SIMPLE_MESSAGES, makeConfig());

    expect(result).toBeNull();
    const events = getDecisionEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      requestedProvider: 'moonshot',
      requestedModel: 'kimi-k2.5',
      resolvedProvider: 'moonshot',
      resolvedModel: 'kimi-k2.5',
      reason: 'user-selected',
      role: null,
    });
  });

  it('事件数据携带 turnId（renderer 据此关联 assistant 消息）', () => {
    const ctx = makeCtx();
    resolveMainChatModelDecision(ctx, SIMPLE_MESSAGES, makeConfig());

    const events = getDecisionEvents(ctx);
    expect(events[0].data.turnId).toBe('turn-42');
  });

  it('adaptive + 简单任务 + payg + 免费模型 key 可用 → 发射 simple-task-free 并返回切换后的配置', () => {
    mockGetApiKey.mockImplementation((provider: string) => (provider === 'zhipu' ? 'zhipu-key' : 'main-key'));
    const ctx = makeCtx();
    const result = resolveMainChatModelDecision(ctx, SIMPLE_MESSAGES, makeConfig({ adaptive: true }));

    expect(result).not.toBeNull();
    expect(result?.provider).toBe('zhipu');
    expect(result?.model).toBe(DEFAULT_MODELS.quick);
    expect(result?.apiKey).toBe('zhipu-key');
    // 跨 provider 切换必须清掉原 baseUrl，否则免费模型会打到原 provider 端点
    expect(result?.baseUrl).toBeUndefined();

    const events = getDecisionEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      requestedModel: 'kimi-k2.5',
      resolvedProvider: 'zhipu',
      resolvedModel: DEFAULT_MODELS.quick,
      reason: 'simple-task-free',
      billingMode: 'payg',
    });
  });

  it('adaptive + 简单任务但免费模型 key 缺失 → 决策标记可用性降级并返回 null', () => {
    mockGetApiKey.mockImplementation((provider: string) => (provider === 'zhipu' ? null : 'main-key'));
    const ctx = makeCtx();
    const result = resolveMainChatModelDecision(ctx, SIMPLE_MESSAGES, makeConfig({ adaptive: true }));

    expect(result).toBeNull();
    const events = getDecisionEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      resolvedProvider: 'moonshot',
      resolvedModel: 'kimi-k2.5',
      reason: 'fallback-availability',
      fallbackFrom: 'zhipu/glm-4-flash',
    });
  });

  it('adaptive + 复杂任务 → user-selected，不切换', () => {
    const ctx = makeCtx();
    const result = resolveMainChatModelDecision(ctx, COMPLEX_MESSAGES, makeConfig({ adaptive: true }));

    expect(result).toBeNull();
    const events = getDecisionEvents(ctx);
    expect(events[0].data.reason).toBe('user-selected');
  });

  it('adaptive + 简单任务 + 包月 provider → billing-gate-skip（计费门控），不切换', () => {
    mockGetSettings.mockReturnValue({
      models: {
        providers: {
          moonshot: { billingMode: 'plan' },
        },
      },
    });
    const ctx = makeCtx();
    const result = resolveMainChatModelDecision(ctx, SIMPLE_MESSAGES, makeConfig({ adaptive: true }));

    expect(result).toBeNull();
    const events = getDecisionEvents(ctx);
    expect(events[0].data).toMatchObject({
      reason: 'billing-gate-skip',
      billingMode: 'plan',
      resolvedModel: 'kimi-k2.5',
    });
  });
});

describe('buildAiSdkAdaptiveFallbackInfo — AI SDK adaptive fallback trace', () => {
  it('records selected main task model when the adaptive candidate fails', () => {
    const info = buildAiSdkAdaptiveFallbackInfo(
      { provider: 'zhipu', model: DEFAULT_MODELS.quick, apiKey: 'zhipu-key' } as ModelConfig,
      makeConfig(),
      new Error('Zhipu API error: 429 rate limit exceeded'),
      'selected',
    );

    expect(info).toMatchObject({
      from: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      to: { provider: 'moonshot', model: 'kimi-k2.5' },
      category: 'rate_limit',
      strategy: 'adaptive-main-task-recovery',
      tried: [
        {
          provider: 'zhipu',
          status: 'tried',
          reason: 'adaptive_candidate_failed',
          category: 'rate_limit',
        },
        {
          provider: 'moonshot',
          status: 'selected',
          reason: 'main_task_model_selected',
          category: 'rate_limit',
        },
      ],
    });
  });

  it('records exhausted when the main task model also fails', () => {
    const info = buildAiSdkAdaptiveFallbackInfo(
      { provider: 'zhipu', model: DEFAULT_MODELS.quick, apiKey: 'zhipu-key' } as ModelConfig,
      makeConfig(),
      new Error('Zhipu API error: 429 rate limit exceeded'),
      'exhausted',
      new Error('Moonshot API error: 503 service unavailable'),
    );

    expect(info).toMatchObject({
      category: 'provider_unavailable',
      reason: expect.stringContaining('503'),
      strategy: 'adaptive-main-task-recovery',
      tried: [
        {
          provider: 'zhipu',
          status: 'tried',
          reason: 'adaptive_candidate_failed',
          category: 'rate_limit',
        },
        {
          provider: 'moonshot',
          status: 'exhausted',
          reason: 'main_task_model_failed',
          category: 'provider_unavailable',
          detail: expect.stringContaining('503'),
        },
      ],
    });
  });
});

describe('runAiSdkInferenceWithProviderFallback — AI SDK 普通 provider fallback trace', () => {
  it('adaptive 普通 AI SDK 调用失败时切到 fallback provider，并记录 selected trace', async () => {
    mockGetApiKey.mockImplementation((provider: string) => (provider === 'deepseek' ? 'deepseek-key' : 'main-key'));
    mockGetSettings.mockReturnValue({
      models: {
        providers: {
          deepseek: {
            enabled: true,
            baseUrl: 'https://deepseek.test/v1',
            protocol: 'openai',
          },
        },
      },
    });
    mockInferenceViaAiSdk
      .mockRejectedValueOnce(new Error('Moonshot API error: 503 service unavailable'))
      .mockResolvedValueOnce({
        type: 'text',
        content: 'fallback ok',
        usage: { inputTokens: 1, outputTokens: 2 },
      });

    const response = await runAiSdkInferenceWithProviderFallback(
      SIMPLE_MESSAGES,
      [],
      makeConfig({ adaptive: true }),
    );

    expect(mockInferenceViaAiSdk).toHaveBeenCalledTimes(2);
    expect(mockInferenceViaAiSdk.mock.calls[1][2]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKey: 'deepseek-key',
      baseUrl: 'https://deepseek.test/v1',
      protocol: 'openai',
      maxTokens: expect.any(Number),
    });
    expect(response).toMatchObject({
      actualProvider: 'deepseek',
      actualModel: 'deepseek-v4-flash',
      fallback: {
        from: { provider: 'moonshot', model: 'kimi-k2.5' },
        to: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        category: 'provider_unavailable',
        strategy: 'adaptive-provider-fallback',
        tried: [
          {
            provider: 'moonshot',
            status: 'tried',
            reason: 'primary_failed',
            category: 'provider_unavailable',
          },
          {
            provider: 'deepseek',
            status: 'selected',
            reason: 'fallback_selected',
            category: 'provider_unavailable',
          },
        ],
      },
    });
  });

  it('显式模型选择失败时不跨 provider fallback', async () => {
    const primaryError = new Error('Moonshot API error: 503 service unavailable');
    mockInferenceViaAiSdk.mockRejectedValueOnce(primaryError);

    await expect(runAiSdkInferenceWithProviderFallback(
      SIMPLE_MESSAGES,
      [],
      makeConfig({ adaptive: false }),
    )).rejects.toBe(primaryError);

    expect(mockInferenceViaAiSdk).toHaveBeenCalledTimes(1);
  });

  it('fallback 候选缺 key 时把 skipped/exhausted trace 挂到原始错误上', async () => {
    const primaryError = new Error('Moonshot API error: 429 rate limit exceeded');
    mockInferenceViaAiSdk.mockRejectedValueOnce(primaryError);
    mockGetApiKey.mockImplementation((provider: string) => (provider === 'deepseek' ? null : 'main-key'));

    let caught: unknown;
    try {
      await runAiSdkInferenceWithProviderFallback(
        SIMPLE_MESSAGES,
        [],
        makeConfig({ adaptive: true }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(primaryError);
    expect((caught as { modelFallback?: unknown }).modelFallback).toMatchObject({
      from: { provider: 'moonshot', model: 'kimi-k2.5' },
      to: { provider: 'moonshot', model: 'kimi-k2.5' },
      category: 'rate_limit',
      strategy: 'adaptive-provider-fallback',
      skipped: [
        {
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          status: 'skipped',
          reason: 'missing_api_key',
        },
      ],
      tried: [
        {
          provider: 'moonshot',
          status: 'tried',
          reason: 'primary_failed',
        },
        {
          provider: 'moonshot',
          status: 'exhausted',
          reason: 'fallback_chain_exhausted',
        },
      ],
    });
    expect(mockInferenceViaAiSdk).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------
// 2. 接线契约（源码扫描，与 modelDecisionWiring.test.ts 同模式）
// --------------------------------------------------------------------------

describe('model_decision 事件接线契约（ADR-019 批 3）', () => {
  const AGENT_CONTRACT_PATH = path.join(ROOT, 'src/shared/contract/agent.ts');
  const INFERENCE_PATH = path.join(ROOT, 'src/host/agent/runtime/contextAssembly/inference.ts');

  it('AgentEvent union 必须包含 model_decision 事件类型', () => {
    const source = readFileSync(AGENT_CONTRACT_PATH, 'utf8');
    expect(source).toMatch(/type: 'model_decision'/);
  });

  it('ModelDecision 类型必须定义在 shared/contract（renderer 可消费），main 层从 shared 导入', () => {
    const sharedSource = readFileSync(path.join(ROOT, 'src/shared/contract/modelDecision.ts'), 'utf8');
    expect(sharedSource).toMatch(/export interface ModelDecision/);
    expect(sharedSource).toMatch(/export type BillingMode/);

    const mainSource = readFileSync(path.join(ROOT, 'src/host/model/modelDecision.ts'), 'utf8');
    expect(mainSource).toMatch(/from '\.\.\/\.\.\/shared\/contract\/modelDecision'/);
  });

  it('runEngineInference 必须在两个引擎分发前统一发射决策（aiSdk / legacy 共用单一发射点）', () => {
    const source = readFileSync(INFERENCE_PATH, 'utf8');
    const fnStart = source.indexOf('function runEngineInference');
    const fnBody = source.slice(fnStart, source.indexOf('\nfunction ', fnStart + 10));

    // 统一决策点在引擎选择之前
    const decisionCallIdx = fnBody.indexOf('resolveMainChatModelDecision(');
    const aiSdkDispatchIdx = fnBody.indexOf('inferenceViaAiSdk(');
    const legacyDispatchIdx = fnBody.indexOf('modelRouter.inference(');
    expect(decisionCallIdx).toBeGreaterThan(-1);
    expect(aiSdkDispatchIdx).toBeGreaterThan(decisionCallIdx);
    expect(legacyDispatchIdx).toBeGreaterThan(decisionCallIdx);

    // E2E local model 早返回前也要发射（headless E2E 依赖此事件）
    const e2eIdx = fnBody.indexOf('shouldUseE2ELocalAgentModelForMessages(');
    expect(e2eIdx).toBeGreaterThan(decisionCallIdx);
  });
});
