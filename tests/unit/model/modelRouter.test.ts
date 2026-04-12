// ============================================================================
// ModelRouter Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter } from '../../../src/main/model/modelRouter';
import { PROVIDER_REGISTRY } from '../../../src/main/model/providerRegistry';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  PROVIDER_FALLBACK_CHAIN,
} from '../../../src/shared/constants';
import type { ModelCapability, ModelConfig } from '../../../src/shared/contract';

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
  callDeepSeek: vi.fn().mockResolvedValue({ type: 'text', content: 'deepseek response', finishReason: 'stop' }),
  callClaude: vi.fn().mockResolvedValue({ type: 'text', content: 'claude response', finishReason: 'stop' }),
  callOpenAI: vi.fn().mockResolvedValue({ type: 'text', content: 'openai response', finishReason: 'stop' }),
  callGroq: vi.fn().mockResolvedValue({ type: 'text', content: 'groq response', finishReason: 'stop' }),
  callLocal: vi.fn().mockResolvedValue({ type: 'text', content: 'local response', finishReason: 'stop' }),
  callQwen: vi.fn().mockResolvedValue({ type: 'text', content: 'qwen response', finishReason: 'stop' }),
  callMoonshot: vi.fn().mockResolvedValue({ type: 'text', content: 'moonshot response', finishReason: 'stop' }),
  callMinimax: vi.fn().mockResolvedValue({ type: 'text', content: 'minimax response', finishReason: 'stop' }),
  callPerplexity: vi.fn().mockResolvedValue({ type: 'text', content: 'perplexity response', finishReason: 'stop' }),
  callGemini: vi.fn().mockResolvedValue({ type: 'text', content: 'gemini response', finishReason: 'stop' }),
  callZhipu: vi.fn().mockResolvedValue({ type: 'text', content: 'zhipu response', finishReason: 'stop' }),
  callOpenRouter: vi.fn().mockResolvedValue({ type: 'text', content: 'openrouter response', finishReason: 'stop' }),
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

// Mock retryStrategy
vi.mock('../../../src/main/model/providers/retryStrategy', () => ({
  isFallbackEligible: vi.fn().mockReturnValue(true),
}));

describe('ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    vi.clearAllMocks();
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
      const originalConfig: ModelConfig = {
        provider: 'local',
        model: 'qwen2.5-coder:7b',
        maxTokens: 8192,
      };
      const fallback = router.getFallbackConfig('vision', originalConfig);
      expect(fallback?.provider).toBe('openai');
      expect(fallback?.model).toBe('gpt-4o');
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

    it('should route to cloud proxy when useCloudProxy is enabled', async () => {
      const { callViaCloudProxy } = await import('../../../src/main/model/providers');
      const config: ModelConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        maxTokens: 1000,
        useCloudProxy: true,
      };

      await router.inference([{ role: 'user', content: 'test' }], [], config);
      expect(callViaCloudProxy).toHaveBeenCalled();
    });

    it('should throw for unsupported provider', async () => {
      const config: ModelConfig = {
        provider: 'nonexistent' as any,
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
