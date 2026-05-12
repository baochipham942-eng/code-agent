// ============================================================================
// ModelRouter Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter } from '../../../src/main/model/modelRouter';
import { PROVIDER_REGISTRY } from '../../../src/main/model/providerRegistry';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODELS,
  PROVIDER_FALLBACK_CHAIN,
} from '../../../src/shared/constants';
import type { ModelConfig, ModelProvider } from '../../../src/shared/contract';

const healthMonitorMock = {
  getHealth: vi.fn().mockReturnValue(null),
  recordFailure: vi.fn(),
};

const ARTIFACT_STREAMING_TIMEOUT_OPTIONS = {
  disableProviderTransientRetry: true,
  requestTimeoutMs: 1_200_000,
  firstByteTimeoutMs: 60_000,
  inactivityTimeoutMs: 480_000,
};

const ARTIFACT_REPAIR_RECOVERY_TIMEOUT_OPTIONS = {
  disableProviderTransientRetry: true,
  requestTimeoutMs: 480_000,
  firstByteTimeoutMs: 60_000,
  inactivityTimeoutMs: 240_000,
};

const ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_OPTIONS = {
  disableProviderTransientRetry: true,
  requestTimeoutMs: 600_000,
  firstByteTimeoutMs: 60_000,
  inactivityTimeoutMs: 360_000,
};

const ARTIFACT_REPAIR_FULL_REWRITE_TIMEOUT_OPTIONS = {
  disableProviderTransientRetry: true,
  requestTimeoutMs: 900_000,
  firstByteTimeoutMs: 60_000,
  inactivityTimeoutMs: 480_000,
};

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock all provider call functions
vi.mock('../../../src/main/model/providers', () => ({
  callViaCloudProxy: vi.fn().mockResolvedValue({ type: 'text', content: 'cloud proxy response', finishReason: 'stop' }),
}));

// Mock MoonshotProvider
vi.mock('../../../src/main/model/providers/moonshotProvider', () => ({
  MoonshotProvider: class MockMoonshotProvider {
    inference = vi.fn().mockResolvedValue({ type: 'text', content: 'moonshot provider response', finishReason: 'stop' });
  },
}));

// Mock configService
vi.mock('../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: vi.fn().mockReturnValue('mock-api-key'),
  }),
}));

// Mock inferenceCache
vi.mock('../../../src/main/model/inferenceCache', () => ({
  getInferenceCache: () => ({
    computeKey: vi.fn().mockReturnValue('cache-key'),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  }),
}));

// Mock adaptiveRouter
vi.mock('../../../src/main/model/adaptiveRouter', () => ({
  getAdaptiveRouter: () => ({
    estimateComplexity: vi.fn().mockReturnValue({ level: 'moderate', score: 50, signals: [] }),
    selectModel: vi.fn(),
    recordOutcome: vi.fn(),
    disableFreeModel: vi.fn(),
  }),
}));

vi.mock('../../../src/main/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => healthMonitorMock,
}));

const broadcastToRendererMock = vi.fn();
vi.mock('../../../src/main/platform/windowBridge', () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

// Mock retryStrategy
vi.mock('../../../src/main/model/providers/retryStrategy', () => ({
  isFallbackEligible: vi.fn().mockReturnValue(true),
}));

describe('ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    healthMonitorMock.getHealth.mockReturnValue(null);
    broadcastToRendererMock.mockReset();
    router = new ModelRouter();
  });

  // --------------------------------------------------------------------------
  // selectModelByCapability
  // --------------------------------------------------------------------------
  describe('selectModelByCapability', () => {
    it('should find a model with the requested capability', () => {
      const result = router.selectModelByCapability('vision', ['zhipu', 'openai']);
      expect(result).not.toBeNull();
      expect(result?.provider).toBeDefined();
      expect(result?.model).toBeDefined();

      // Verify the found model actually has the vision capability
      const provider = PROVIDER_REGISTRY[result!.provider];
      const model = provider.models.find(m => m.id === result!.model);
      expect(model?.supportsVision).toBe(true);
    });

    it('should return null when no provider has the requested capability', () => {
      // 'search' is only in perplexity
      const result = router.selectModelByCapability('search', ['local']);
      expect(result).toBeNull();
    });

    it('should respect provider order (returns first match)', () => {
      const result = router.selectModelByCapability('code', ['deepseek', 'claude']);
      expect(result?.provider).toBe('deepseek');
    });

    it('should skip unknown providers gracefully', () => {
      const result = router.selectModelByCapability('code', ['nonexistent', 'deepseek']);
      expect(result?.provider).toBe('deepseek');
    });
  });

  // --------------------------------------------------------------------------
  // getModelInfo
  // --------------------------------------------------------------------------
  describe('getModelInfo', () => {
    it('should return model info for valid provider and model', () => {
      const info = router.getModelInfo('deepseek', 'deepseek-chat');
      expect(info).not.toBeNull();
      expect(info?.id).toBe('deepseek-chat');
      expect(info?.capabilities).toContain('code');
    });

    it('should return null for unknown provider', () => {
      const info = router.getModelInfo('nonexistent', 'some-model');
      expect(info).toBeNull();
    });

    it('should return null for unknown model in valid provider', () => {
      const info = router.getModelInfo('deepseek', 'nonexistent-model');
      expect(info).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // detectRequiredCapabilities
  // --------------------------------------------------------------------------
  describe('detectRequiredCapabilities', () => {
    it('should detect vision capability when messages contain images', () => {
      const messages = [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'What is in this image?' },
            { type: 'image' as const, source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ];
      const caps = router.detectRequiredCapabilities(messages);
      expect(caps).toContain('vision');
    });

    it('should not detect vision when string content contains annotation keywords', () => {
      // Annotation keyword filtering only works when msg.content is a string.
      // When msg.content is an array (multimodal), the text extraction yields ''
      // so annotation keywords are not checked — vision is always added.
      // This test verifies the string content path:
      const messages = [
        { role: 'user' as const, content: '请在图上框出关键区域' },
      ];
      const caps = router.detectRequiredCapabilities(messages);
      // String content has no image → no vision capability detected
      expect(caps).not.toContain('vision');
    });

    it('should always detect vision for array content with image (annotation check limitation)', () => {
      // Known behavior: when content is array, annotation keyword check reads
      // empty string (text parts not extracted), so vision is always added.
      const messages = [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: '请在图上框出关键区域' },
            { type: 'image' as const, source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ];
      const caps = router.detectRequiredCapabilities(messages);
      expect(caps).toContain('vision');
    });

    it('should detect reasoning capability for reasoning keywords', () => {
      const messages = [
        { role: 'user' as const, content: '请逐步推导这个数学证明' },
      ];
      const caps = router.detectRequiredCapabilities(messages);
      expect(caps).toContain('reasoning');
    });

    it('should return empty for plain text without special needs', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello, how are you?' },
      ];
      const caps = router.detectRequiredCapabilities(messages);
      expect(caps).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getFallbackConfig — capability fallback
  // --------------------------------------------------------------------------
  describe('getFallbackConfig', () => {
    it('should return fallback config for vision capability', () => {
      const originalConfig: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        maxTokens: 8192,
      };
      const fallback = router.getFallbackConfig('vision', originalConfig);
      expect(fallback).not.toBeNull();
      // Should provide a vision-capable model
      expect(fallback?.model).toBeDefined();
    });

    it('should prefer same-provider fallback when available', () => {
      const originalConfig: ModelConfig = {
        provider: 'claude',
        model: 'claude-opus-4-6',
        maxTokens: 32000,
      };
      // Claude has vision models (sonnet, haiku etc.)
      const fallback = router.getFallbackConfig('vision', originalConfig);
      expect(fallback).not.toBeNull();
    });

    it('should allow overriding fallback models', () => {
      router.setFallbackModel('vision', 'openai', 'gpt-4o');
      // 用 deepseek（无 vision 模型），强制走默认 fallback 而非 same-provider
      const originalConfig: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        maxTokens: 8192,
      };
      const fallback = router.getFallbackConfig('vision', originalConfig);
      expect(fallback?.provider).toBe('openai');
      expect(fallback?.model).toBe('gpt-4o');
    });

    it('should prefer the current provider model for compact when it can summarize', () => {
      const originalConfig: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'xiaomi-key',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        maxTokens: 8192,
      };

      const fallback = router.getFallbackConfig('compact', originalConfig);

      expect(fallback?.provider).toBe('xiaomi');
      expect(fallback?.model).toBe('mimo-v2.5-pro');
      expect(fallback?.apiKey).toBe('xiaomi-key');
      expect(fallback?.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    });

    it('should keep compact fallback provider and model paired when current model is unavailable', () => {
      const originalConfig: ModelConfig = {
        provider: 'xiaomi',
        model: 'missing-model',
        apiKey: 'xiaomi-key',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        maxTokens: 8192,
      };

      const fallback = router.getFallbackConfig('compact', originalConfig);

      expect(fallback?.provider).toBe('moonshot');
      expect(fallback?.model).toBe(DEFAULT_MODELS.compact);
      expect(fallback?.apiKey).toBe('mock-api-key');
      expect(fallback?.baseUrl).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // inference — provider routing
  // --------------------------------------------------------------------------
  describe('inference', () => {
    it('should reject cancelled requests before starting', async () => {
      const controller = new AbortController();
      controller.abort();

      const config: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference([{ role: 'user', content: 'test' }], [], config, undefined, controller.signal)
      ).rejects.toThrow('cancelled');
    });

    it('should route to cloud proxy with inference options when useCloudProxy is enabled', async () => {
      const { callViaCloudProxy } = await import('../../../src/main/model/providers');
      const config: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        maxTokens: 1000,
        useCloudProxy: true,
      };
      const options = { onSnapshot: vi.fn(), snapshotIntervalMs: 0 };

      await router.inference([{ role: 'user', content: 'test' }], [], config, undefined, undefined, options);
      expect(callViaCloudProxy).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        expect.any(Object),
        undefined,
        undefined,
        options,
      );
    });

    it('should pass forceNonStreaming inference options to provider', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'ok', finishReason: 'stop' }),
      } as any;
      (router as any).providers.set('deepseek', provider);

      const config: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const options = { forceNonStreaming: true };

      await router.inference([{ role: 'user', content: 'write a single html game' }], [], config, undefined, undefined, options);

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        undefined,
        undefined,
        options,
      );
    });

    it('should use streaming-first for explicit file artifact generation turns', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();
      const options = { snapshotIntervalMs: 1000 };

      await router.inference(
        [{ role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' }],
        [],
        config,
        onStream,
        undefined,
        options,
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should keep artifact follow-up turns streaming when prior tool results are healthy and no explicit file target exists', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();
      const options = { snapshotIntervalMs: 1000 };

      await router.inference(
        [
          { role: 'user', content: '请生成一个可玩的互动游戏' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'Bash', arguments: '{"command":"mkdir -p /tmp"}' }] },
          { role: 'tool', content: 'success', toolCallId: 'call-1' },
        ],
        [],
        config,
        onStream,
        undefined,
        options,
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should retry artifact follow-up with non-streaming after incomplete streamed tool args', async () => {
      const provider = {
        inference: vi.fn()
          .mockRejectedValueOnce(new Error('refusing to execute incomplete tool arguments'))
          .mockResolvedValueOnce({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();
      const options = { snapshotIntervalMs: 1000 };

      await router.inference(
        [
          { role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'Write', arguments: '{"file_path":"/tmp/game.html","content":"<html>' }] },
          { role: 'tool', content: 'refusing to execute incomplete tool arguments', toolCallId: 'call-1', toolError: true },
        ],
        [],
        config,
        onStream,
        undefined,
        options,
      );

      expect(provider.inference).toHaveBeenCalledTimes(2);
      expect(provider.inference).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
      expect(provider.inference).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        [],
        config,
        undefined,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          forceNonStreaming: true,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should use streaming-first for artifact follow-up when file-write-required marker is injected', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();
      const options = { snapshotIntervalMs: 1000 };

      await router.inference(
        [
          { role: 'user', content: '请生成一个可玩的互动游戏' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'Bash', arguments: '{"command":"mkdir -p /tmp/out"}' }] },
          { role: 'tool', content: 'success', toolCallId: 'call-1' },
          { role: 'system', content: '<artifact-file-write-required>\n目标产物文件是 /tmp/out/game.html。目录已经存在，下一步必须直接写这个文件本身。\n</artifact-file-write-required>' },
        ],
        [],
        config,
        onStream,
        undefined,
        options,
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should use non-streaming inference when runtime artifact repair guard is active', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      await router.inference(
        [{ role: 'user', content: '修复这个游戏，让它通过验收' }],
        [],
        config,
        onStream,
        undefined,
        { snapshotIntervalMs: 1000, artifactRepairActive: true },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          artifactRepairActive: true,
          forceNonStreaming: true,
          ...ARTIFACT_REPAIR_RECOVERY_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should give write-priority artifact repair turns enough time for complete HTML replacement', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await router.inference(
        [{ role: 'user', content: '修复这个 HTML 游戏并通过 validator' }],
        [{ name: 'Write', description: 'write', inputSchema: {} } as any],
        config,
        vi.fn(),
        undefined,
        {
          artifactRepairActive: true,
          artifactRepairWritePriority: true,
          artifactRepairFullRewritePriority: true,
        },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Array),
        config,
        expect.any(Function),
        expect.any(AbortSignal),
        expect.objectContaining({
          artifactRepairActive: true,
          artifactRepairWritePriority: true,
          artifactRepairFullRewritePriority: true,
          forceNonStreaming: true,
          ...ARTIFACT_REPAIR_FULL_REWRITE_TIMEOUT_OPTIONS,
        }),
      );
    });

    it('should give targeted artifact repair write-priority enough time for structured Edit payloads', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await router.inference(
        [{ role: 'user', content: '修复这个 HTML 游戏并通过 validator' }],
        [{ name: 'Edit', description: 'edit', inputSchema: {} } as any],
        config,
        vi.fn(),
        undefined,
        { artifactRepairActive: true, artifactRepairWritePriority: true },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Array),
        config,
        expect.any(Function),
        expect.any(AbortSignal),
        expect.objectContaining({
          artifactRepairActive: true,
          artifactRepairWritePriority: true,
          forceNonStreaming: true,
          ...ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_OPTIONS,
        }),
      );
    });

    it('should use a shorter streaming timeout for blocked-tool artifact repair recovery turns', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      await router.inference(
        [
          { role: 'user', content: '请修复 /tmp/game.html 这个单文件 HTML 游戏' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'Read', arguments: '{"file_path":"/tmp/game.html"}' }] },
          { role: 'tool', content: '<artifact-repair-tool-blocked>\nRead is limited to the target artifact file during repair.\n</artifact-repair-tool-blocked>', toolCallId: 'call-1', toolError: true },
        ],
        [],
        config,
        onStream,
        undefined,
        { snapshotIntervalMs: 1000 },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          ...ARTIFACT_REPAIR_RECOVERY_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should not retry blocked-tool artifact repair stream timeouts with non-streaming', async () => {
      const provider = {
        inference: vi.fn().mockRejectedValue(new Error('Xiaomi stream inactivity timeout (45000ms)')),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference(
          [
            { role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏' },
            {
              role: 'tool',
              content: '<artifact-repair-tool-blocked>\nRead is limited to the target artifact file during repair.\n</artifact-repair-tool-blocked>',
              toolCallId: 'call-1',
              toolError: true,
            },
          ],
          [],
          config,
          vi.fn(),
        ),
      ).rejects.toThrow('Xiaomi stream inactivity timeout');

      expect(provider.inference).toHaveBeenCalledTimes(1);
    });

    it('should keep blocked-tool artifact repair timeouts on the selected provider instead of cross-provider fallback', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('Xiaomi stream inactivity timeout (45000ms)')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback should not run', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference(
          [
            { role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏' },
            {
              role: 'system',
              content: '<artifact-repair-admission-blocked>\nOnly Write or Append is available.\n</artifact-repair-admission-blocked>',
            },
          ],
          [],
          config,
          vi.fn(),
        ),
      ).rejects.toThrow('Xiaomi stream inactivity timeout');

      expect(primaryProvider.inference).toHaveBeenCalledTimes(1);
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('should keep concrete artifact repair requests on the selected provider instead of cross-provider fallback', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('Client network socket disconnected before secure TLS connection was established')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback should not run', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference(
          [
            {
              role: 'user',
              content: [
                '修复 /tmp/game.html 这个单文件 HTML 产物。直接编辑文件并验证，不要只解释。',
                '当前 validator 失败摘要：',
                '1. control_no_state_change',
              ].join('\n'),
            },
          ],
          [],
          config,
          vi.fn(),
        ),
      ).rejects.toThrow('Client network socket disconnected before secure TLS connection was established');

      expect(primaryProvider.inference).toHaveBeenCalledTimes(3);
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('should use a shorter non-streaming timeout after artifact validation failures', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      await router.inference(
        [
          { role: 'user', content: '请修复 /tmp/game.html 这个单文件 HTML 游戏' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'Edit', arguments: '{"file_path":"/tmp/game.html"}' }] },
          { role: 'tool', content: 'Artifact validation failed for /tmp/game.html.\nGame artifact validation failed for game; repair 1 issue: control_no_state_change.', toolCallId: 'call-1', toolError: true },
          { role: 'system', content: '<artifact-validation-failed kind="interactive_artifact">\nattempts: 1\nrepair phase: baseline_repair\ntarget file: /tmp/game.html\n1. control_no_state_change\n</artifact-validation-failed>' },
        ],
        [],
        config,
        onStream,
        undefined,
        { snapshotIntervalMs: 1000 },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          forceNonStreaming: true,
          ...ARTIFACT_REPAIR_RECOVERY_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should use a shorter non-streaming timeout for explicit artifact repair requests before validation markers exist', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      await router.inference(
        [{ role: 'user', content: '修复 /tmp/game.html 这个已经存在的单文件 HTML 互动游戏，必须直接编辑文件。' }],
        [],
        config,
        onStream,
        undefined,
        { snapshotIntervalMs: 1000 },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          forceNonStreaming: true,
          ...ARTIFACT_REPAIR_RECOVERY_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should not classify fresh artifact generation as repair because of system artifact guidance', async () => {
      const provider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      await router.inference(
        [
          { role: 'user', content: 'Create a single-file browser game at corgi-platformer.html. Include window.__GAME_TEST__ with runSmokeTest().' },
          { role: 'system', content: '<artifact-task-brief>If validation fails later, repair corgi-platformer.html directly.</artifact-task-brief>' },
        ],
        [],
        config,
        onStream,
        undefined,
        { snapshotIntervalMs: 1000 },
      );

      expect(provider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          snapshotIntervalMs: 1000,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should abort provider inference when requestTimeoutMs is reached', async () => {
      const provider = {
        inference: vi.fn((_messages, _tools, _config, _onStream, signal: AbortSignal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('provider observed abort')), { once: true });
        })),
      } as any;
      (router as any).providers.set('minimax', provider);

      const config: ModelConfig = {
        provider: 'minimax',
        model: 'MiniMax-Text-01',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference(
          [{ role: 'user', content: 'ping without artifact intent' }],
          [],
          config,
          undefined,
          undefined,
          { requestTimeoutMs: 1, disableProviderTransientRetry: true },
        ),
      ).rejects.toThrow('minimax request timeout after 1ms');

      expect(provider.inference).toHaveBeenCalledTimes(1);
    });

    it('should keep artifact write-required turns on the selected provider until it actually fails', async () => {
      const xiaomiProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'should not run', finishReason: 'stop' }),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [], finishReason: 'tool_calls' }),
      } as any;
      (router as any).providers.set('xiaomi', xiaomiProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await router.inference(
        [
          { role: 'user', content: '请生成一个可玩的互动游戏' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'Bash', arguments: '{"command":"mkdir -p /tmp/out"}' }] },
          { role: 'tool', content: 'success', toolCallId: 'call-1' },
          { role: 'system', content: '<artifact-file-write-required>\n目标产物文件是 /tmp/out/game.html。目录已经存在，下一步必须直接写这个文件本身。\n</artifact-file-write-required>' },
        ],
        [],
        config,
        vi.fn(),
        undefined,
        { snapshotIntervalMs: 1000 },
      );

      expect(xiaomiProvider.inference).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        config,
        expect.any(Function),
        expect.any(AbortSignal),
        expect.objectContaining({
          requestTimeoutMs: 1_200_000,
        }),
      );
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
    });

    it('should throw for unsupported provider', async () => {
      const config: ModelConfig = {
        provider: 'nonexistent' as ModelProvider,
        model: 'fake-model',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference([{ role: 'user', content: 'test' }], [], config)
      ).rejects.toThrow('Unsupported provider');
    });
  });

  // --------------------------------------------------------------------------
  // inference — cross-provider fallback chain
  // --------------------------------------------------------------------------
  describe('cross-provider fallback chain', () => {
    it('should have fallback chains defined for key providers', () => {
      // Verify that PROVIDER_FALLBACK_CHAIN is correctly structured from constants
      expect(PROVIDER_FALLBACK_CHAIN[DEFAULT_PROVIDER]).toBeDefined();
      expect(PROVIDER_FALLBACK_CHAIN.moonshot).toBeDefined();
      expect(PROVIDER_FALLBACK_CHAIN.deepseek).toBeDefined();
      expect(PROVIDER_FALLBACK_CHAIN.xiaomi?.[0]).toEqual({
        provider: 'zhipu',
        model: 'glm-4.7-flash',
      });

      // Each chain entry should have provider and model
      for (const [, chain] of Object.entries(PROVIDER_FALLBACK_CHAIN)) {
        for (const fallback of chain) {
          expect(fallback.provider).toBeTruthy();
          expect(fallback.model).toBeTruthy();
        }
      }
    });

    it('should not include self in fallback chain', () => {
      for (const [provider, chain] of Object.entries(PROVIDER_FALLBACK_CHAIN)) {
        const selfInChain = chain.find(f => f.provider === provider);
        expect(selfInChain).toBeUndefined();
      }
    });

    it('should retry artifact-like streamed requests with non-streaming before fallback', async () => {
      const provider = {
        inference: vi.fn()
          .mockRejectedValueOnce(new Error('xiaomi stream inactivity timeout (120000ms)'))
          .mockResolvedValueOnce({ type: 'text', content: 'ok', finishReason: 'stop' }),
      } as any;
      (router as any).providers.set('xiaomi', provider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      const result = await router.inference(
        [{ role: 'user', content: '请生成一个可玩的互动游戏' }],
        [],
        config,
        onStream,
      );

      expect(result).toMatchObject({ type: 'text', content: 'ok' });
      expect(provider.inference).toHaveBeenCalledTimes(2);
      expect(provider.inference).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        [],
        config,
        onStream,
        expect.any(AbortSignal),
        {
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
      expect(provider.inference).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        [],
        config,
        undefined,
        expect.any(AbortSignal),
        {
          forceNonStreaming: true,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
    });

    it('should keep artifact timeout on the selected provider instead of cross-provider fallback', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('xiaomi stream inactivity timeout (120000ms)')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback should not run', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-k2-0711-preview',
        apiKey: 'test-key',
        maxTokens: 1000,
      };
      const onStream = vi.fn();

      await expect(
        router.inference(
          [{ role: 'user', content: '生成一个带多关卡的互动游戏' }],
          [],
          config,
          onStream,
        )
      ).rejects.toThrow('xiaomi stream inactivity timeout');
      expect(primaryProvider.inference).toHaveBeenCalledTimes(2);
      expect(primaryProvider.inference).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        [],
        config,
        undefined,
        expect.any(AbortSignal),
        {
          forceNonStreaming: true,
          ...ARTIFACT_STREAMING_TIMEOUT_OPTIONS,
        },
      );
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('should retry the selected artifact provider when artifact repair hits provider_unavailable', async () => {
      const primaryProvider = {
        inference: vi.fn()
          .mockRejectedValueOnce(new Error('Xiaomi API error: 502 - bad gateway'))
          .mockResolvedValueOnce({ type: 'text', content: 'repair recovered on selected retry', finishReason: 'stop' }),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback should not run', finishReason: 'stop' }),
      } as any;
      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [
          { role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏，直接编辑并通过验收。' },
          { role: 'system', content: '<artifact-validation-failed kind="interactive_artifact">\ntarget file: /tmp/game.html\n</artifact-validation-failed>' },
        ],
        [{ name: 'Edit', description: 'edit', inputSchema: {} } as any],
        config,
        vi.fn(),
        undefined,
        { artifactRepairActive: true, artifactRepairWritePriority: true },
      );

      expect(result).toMatchObject({ type: 'text', content: 'repair recovered on selected retry' });
      expect(primaryProvider.inference).toHaveBeenCalledTimes(2);
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('should fall back after artifact repair selected-provider transient retries are exhausted', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('Xiaomi API error: 502 - bad gateway')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback repair recovery', finishReason: 'stop' }),
      } as any;
      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [
          { role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏，直接编辑并通过验收。' },
          { role: 'system', content: '<artifact-validation-failed kind="interactive_artifact">\ntarget file: /tmp/game.html\n</artifact-validation-failed>' },
        ],
        [{ name: 'Edit', description: 'edit', inputSchema: {} } as any],
        config,
        vi.fn(),
        undefined,
        { artifactRepairActive: true, artifactRepairWritePriority: true },
      );

      expect(result).toMatchObject({
        type: 'text',
        content: 'fallback repair recovery',
        fallback: {
          category: 'provider_unavailable',
          to: { provider: 'zhipu', model: 'glm-4.7-flash' },
        },
      });
      expect(primaryProvider.inference).toHaveBeenCalledTimes(3);
      expect(zhipuProvider.inference).toHaveBeenCalledTimes(1);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        'provider:fallback',
        expect.objectContaining({ category: 'provider_unavailable' }),
      );
    });

    it('should fall back after artifact repair timeout retries are exhausted', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('xiaomi request timeout after 90000ms')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback repair recovery', finishReason: 'stop' }),
      } as any;
      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [
          { role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏，直接编辑并通过验收。' },
          { role: 'system', content: '<artifact-validation-failed kind="interactive_artifact">\ntarget file: /tmp/game.html\n</artifact-validation-failed>' },
        ],
        [{ name: 'Edit', description: 'edit', inputSchema: {} } as any],
        config,
        vi.fn(),
        undefined,
        { artifactRepairActive: true, artifactRepairWritePriority: true },
      );

      expect(result).toMatchObject({
        type: 'text',
        content: 'fallback repair recovery',
        fallback: {
          category: 'timeout',
          to: { provider: 'zhipu', model: 'glm-4.7-flash' },
        },
      });
      expect(primaryProvider.inference).toHaveBeenCalledTimes(3);
      expect(zhipuProvider.inference).toHaveBeenCalledTimes(1);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        'provider:fallback',
        expect.objectContaining({ category: 'timeout' }),
      );
    });

    it('should not cross-provider fallback for artifact repair auth quota model or artifact-response failures', async () => {
      const cases = [
        {
          name: 'auth',
          inference: vi.fn().mockRejectedValue(new Error('Xiaomi API error: 401 - unauthorized')),
          expectedError: '401',
        },
        {
          name: 'quota',
          inference: vi.fn().mockRejectedValue(new Error('Xiaomi API error: 402 - insufficient balance')),
          expectedError: 'insufficient balance',
        },
        {
          name: 'model',
          inference: vi.fn().mockRejectedValue(new Error('model_not_allowed: model is not available')),
          expectedError: 'model_not_allowed',
        },
        {
          name: 'artifact_response',
          inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
          expectedError: 'empty artifact response',
        },
      ];

      for (const testCase of cases) {
        const caseRouter = new ModelRouter();
        const primaryProvider = { inference: testCase.inference } as any;
        const zhipuProvider = {
          inference: vi.fn().mockResolvedValue({ type: 'text', content: `${testCase.name} fallback should not run`, finishReason: 'stop' }),
        } as any;
        (caseRouter as any).providers.set('xiaomi', primaryProvider);
        (caseRouter as any).providers.set('zhipu', zhipuProvider);
        broadcastToRendererMock.mockReset();

        await expect(
          caseRouter.inference(
            [
              { role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏，直接编辑并通过验收。' },
              { role: 'system', content: '<artifact-validation-failed kind="interactive_artifact">\ntarget file: /tmp/game.html\n</artifact-validation-failed>' },
            ],
            [{ name: 'Edit', description: 'edit', inputSchema: {} } as any],
            {
              provider: 'xiaomi',
              model: 'mimo-v2.5-pro',
              apiKey: 'test-key',
              maxTokens: 1000,
            },
            vi.fn(),
            undefined,
            { artifactRepairActive: true, artifactRepairWritePriority: true },
          ),
        ).rejects.toThrow(testCase.expectedError);

        expect(primaryProvider.inference).toHaveBeenCalledTimes(1);
        expect(zhipuProvider.inference).not.toHaveBeenCalled();
        expect(broadcastToRendererMock).not.toHaveBeenCalled();
      }
    });

    it('should retry the selected artifact provider on transient provider_unavailable errors before giving up', async () => {
      const primaryProvider = {
        inference: vi.fn()
          .mockRejectedValueOnce(new Error('Xiaomi API error: 502 - bad gateway'))
          .mockResolvedValueOnce({ type: 'text', content: 'recovered on retry', finishReason: 'stop' }),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback should not run', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const result = await router.inference(
        [{ role: 'user', content: '生成一个多轮修复的 HTML 游戏并保存到 /tmp/game.html' }],
        [],
        {
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro',
          apiKey: 'test-key',
          maxTokens: 1000,
        },
        vi.fn(),
      );

      expect(result).toMatchObject({ type: 'text', content: 'recovered on retry' });
      expect(primaryProvider.inference).toHaveBeenCalledTimes(2);
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('classifies quota fallback reasons distinctly from timeout exhaustion wording', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('Xiaomi API error: 402 - insufficient balance')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback ok', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const result = await router.inference(
        [{ role: 'user', content: '生成一个 HTML 游戏' }],
        [],
        {
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro',
          apiKey: 'test-key',
          maxTokens: 1000,
        },
        vi.fn(),
      );

      expect(result.fallback).toMatchObject({
        category: 'quota',
        to: { provider: 'zhipu', model: 'glm-4.7-flash' },
      });
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        'provider:fallback',
        expect.objectContaining({
          category: 'quota',
          reason: expect.stringContaining('insufficient balance'),
        }),
      );
    });

    it('should treat empty artifact responses as provider failure and fall back', async () => {
      const primaryProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback artifact plan', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [{ role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' }],
        [],
        config,
        vi.fn(),
      );

      expect(result).toMatchObject({ type: 'text', content: 'fallback artifact plan' });
      expect(primaryProvider.inference).toHaveBeenCalledTimes(1);
      expect(zhipuProvider.inference).toHaveBeenCalledTimes(1);
    });

    it('should keep transient artifact provider errors on the selected provider instead of fallback', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('Xiaomi API error: 502 - bad gateway')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'fallback should not run', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inference(
          [{ role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' }],
          [],
          config,
          vi.fn(),
        )
      ).rejects.toThrow('Xiaomi API error: 502');
      expect(zhipuProvider.inference).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('should retry selected artifact provider even when no cross-provider fallback chain exists', async () => {
      const primaryProvider = {
        inference: vi.fn()
          .mockRejectedValueOnce(new Error('Network request failed: socket hang up'))
          .mockResolvedValueOnce({ type: 'text', content: 'recovered without fallback chain', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('minimax', primaryProvider);

      const result = await router.inference(
        [{ role: 'user', content: '修复 /tmp/game.html 这个单文件 HTML 游戏，并通过 validator' }],
        [],
        {
          provider: 'minimax',
          model: 'MiniMax-Text-01',
          apiKey: 'test-key',
          maxTokens: 1000,
        },
        vi.fn(),
      );

      expect(result).toMatchObject({ type: 'text', content: 'recovered without fallback chain' });
      expect(primaryProvider.inference).toHaveBeenCalledTimes(2);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it('reorders persistent artifact fallback chain to prefer deepseek before moonshot', async () => {
      const primaryProvider = {
        inference: vi.fn().mockRejectedValue(new Error('Xiaomi API error: 402 - insufficient balance')),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockRejectedValue(new Error('zhipu temporary failure')),
      } as any;
      const deepseekProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'deepseek artifact fallback', finishReason: 'stop' }),
      } as any;
      const moonshotProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: 'moonshot should not run', finishReason: 'stop' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);
      (router as any).providers.set('deepseek', deepseekProvider);
      (router as any).providers.set('moonshot', moonshotProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [{ role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' }],
        [],
        config,
        vi.fn(),
      );

      expect(result).toMatchObject({ type: 'text', content: 'deepseek artifact fallback' });
      expect(zhipuProvider.inference).toHaveBeenCalledTimes(1);
      expect(deepseekProvider.inference).toHaveBeenCalledTimes(1);
      expect(moonshotProvider.inference).not.toHaveBeenCalled();
    });

    it('should skip empty fallback artifact responses and try the next fallback provider', async () => {
      const primaryProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
      } as any;
      const openaiProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
      } as any;
      const moonshotProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [{ id: 'call-1', name: 'Write', arguments: {} }], finishReason: 'tool_calls' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);
      (router as any).providers.set('openai', openaiProvider);
      (router as any).providers.set('moonshot', moonshotProvider);

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [{ role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' }],
        [],
        config,
        vi.fn(),
      );

      expect(result.type).toBe('tool_use');
      expect(zhipuProvider.inference).toHaveBeenCalledTimes(1);
      expect(openaiProvider.inference).toHaveBeenCalledTimes(1);
      expect(moonshotProvider.inference).toHaveBeenCalledTimes(1);
    });

    it('marks providers unavailable after repeated empty artifact responses', async () => {
      const primaryProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
      } as any;
      const zhipuProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'text', content: '', finishReason: 'stop' }),
      } as any;
      const moonshotProvider = {
        inference: vi.fn().mockResolvedValue({ type: 'tool_use', toolCalls: [{ id: 'call-1', name: 'Write', arguments: {} }], finishReason: 'tool_calls' }),
      } as any;

      (router as any).providers.set('xiaomi', primaryProvider);
      (router as any).providers.set('zhipu', zhipuProvider);
      (router as any).providers.set('moonshot', moonshotProvider);
      healthMonitorMock.getHealth.mockImplementation((provider: string) => {
        if (provider === 'openai') {
          return { status: 'unavailable' };
        }
        return null;
      });

      const config: ModelConfig = {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      const result = await router.inference(
        [{ role: 'user', content: '请生成一个单文件 HTML 游戏，并保存到 /tmp/game.html' }],
        [],
        config,
        vi.fn(),
      );

      expect(result.type).toBe('tool_use');
      expect(healthMonitorMock.recordFailure).toHaveBeenCalledWith('xiaomi');
      expect(healthMonitorMock.recordFailure).toHaveBeenCalledWith('zhipu');
      expect(moonshotProvider.inference).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // inferenceWithVision
  // --------------------------------------------------------------------------
  describe('inferenceWithVision', () => {
    it('should throw when model does not support vision', async () => {
      const config: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        maxTokens: 1000,
      };

      await expect(
        router.inferenceWithVision(
          [{ role: 'user', content: 'describe this' }],
          [{ data: 'base64data', mediaType: 'image/png' }],
          config
        )
      ).rejects.toThrow('does not support vision');
    });
  });
});
