// ============================================================================
// Provider Registry Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { PROVIDER_REGISTRY, getAvailableModels } from '../../../src/main/model/providerRegistry';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  MODEL_API_ENDPOINTS,
  PROVIDER_FALLBACK_CHAIN,
} from '../../../src/shared/constants';
import type { ModelCapability, ModelProvider } from '../../../src/shared/types';

describe('ProviderRegistry', () => {
  // --------------------------------------------------------------------------
  // Registry structure integrity
  // --------------------------------------------------------------------------
  describe('registry structure', () => {
    it('should have all expected providers registered', () => {
      const expectedProviders: ModelProvider[] = [
        'deepseek', 'claude', 'openai', 'groq', 'local',
        'zhipu', 'qwen', 'moonshot', 'minimax', 'gemini',
        'perplexity', 'openrouter',
      ];
      for (const provider of expectedProviders) {
        expect(PROVIDER_REGISTRY[provider]).toBeDefined();
        expect(PROVIDER_REGISTRY[provider].id).toBe(provider);
      }
    });

    it('should have non-empty models array for each provider', () => {
      for (const [id, config] of Object.entries(PROVIDER_REGISTRY)) {
        expect(config.models.length).toBeGreaterThan(0);
      }
    });

    it('should have valid model structure for all models', () => {
      for (const [, config] of Object.entries(PROVIDER_REGISTRY)) {
        for (const model of config.models) {
          expect(model.id).toBeTruthy();
          expect(model.name).toBeTruthy();
          expect(Array.isArray(model.capabilities)).toBe(true);
          expect(model.maxTokens).toBeGreaterThan(0);
          expect(typeof model.supportsTool).toBe('boolean');
          expect(typeof model.supportsVision).toBe('boolean');
          expect(typeof model.supportsStreaming).toBe('boolean');
        }
      }
    });

    it('should use API endpoints from constants (not hardcoded URLs)', () => {
      // Verify that baseUrl values match MODEL_API_ENDPOINTS
      expect(PROVIDER_REGISTRY.deepseek.baseUrl).toBe(MODEL_API_ENDPOINTS.deepseek);
      expect(PROVIDER_REGISTRY.claude.baseUrl).toBe(MODEL_API_ENDPOINTS.claude);
      expect(PROVIDER_REGISTRY.openai.baseUrl).toBe(MODEL_API_ENDPOINTS.openai);
      expect(PROVIDER_REGISTRY.groq.baseUrl).toBe(MODEL_API_ENDPOINTS.groq);
      expect(PROVIDER_REGISTRY.zhipu.baseUrl).toBe(MODEL_API_ENDPOINTS.zhipu);
      expect(PROVIDER_REGISTRY.qwen.baseUrl).toBe(MODEL_API_ENDPOINTS.qwen);
      expect(PROVIDER_REGISTRY.moonshot.baseUrl).toBe(MODEL_API_ENDPOINTS.moonshot);
      expect(PROVIDER_REGISTRY.minimax.baseUrl).toBe(MODEL_API_ENDPOINTS.minimax);
      expect(PROVIDER_REGISTRY.perplexity.baseUrl).toBe(MODEL_API_ENDPOINTS.perplexity);
      expect(PROVIDER_REGISTRY.gemini.baseUrl).toBe(MODEL_API_ENDPOINTS.gemini);
      expect(PROVIDER_REGISTRY.openrouter.baseUrl).toBe(MODEL_API_ENDPOINTS.openrouter);
    });
  });

  // --------------------------------------------------------------------------
  // Model capability validation
  // --------------------------------------------------------------------------
  describe('capability matching', () => {
    it('should have at least one model with vision capability', () => {
      const visionModels = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .filter(m => m.supportsVision);
      expect(visionModels.length).toBeGreaterThan(0);
    });

    it('should have at least one model with code capability', () => {
      const codeModels = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .filter(m => m.capabilities.includes('code'));
      expect(codeModels.length).toBeGreaterThan(0);
    });

    it('should have at least one model with reasoning capability', () => {
      const reasoningModels = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .filter(m => m.capabilities.includes('reasoning'));
      expect(reasoningModels.length).toBeGreaterThan(0);
    });

    it('should have at least one free model', () => {
      const freeModels = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .filter(m => m.costType === 'free');
      expect(freeModels.length).toBeGreaterThan(0);
    });

    it('vision models should have supportsVision flag set to true', () => {
      for (const config of Object.values(PROVIDER_REGISTRY)) {
        for (const model of config.models) {
          if (model.capabilities.includes('vision')) {
            expect(model.supportsVision).toBe(true);
          }
        }
      }
    });

    it('models with visionCapabilities should have supportsVision=true', () => {
      for (const config of Object.values(PROVIDER_REGISTRY)) {
        for (const model of config.models) {
          if (model.visionCapabilities) {
            expect(model.supportsVision).toBe(true);
          }
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Token window constraints
  // --------------------------------------------------------------------------
  describe('token window constraints', () => {
    it('all models should have positive maxTokens', () => {
      for (const config of Object.values(PROVIDER_REGISTRY)) {
        for (const model of config.models) {
          expect(model.maxTokens).toBeGreaterThan(0);
        }
      }
    });

    it('long context models should have maxTokens >= 128K', () => {
      const longContextModels = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .filter(m => m.capabilities.includes('longContext'));

      for (const model of longContextModels) {
        expect(model.maxTokens).toBeGreaterThanOrEqual(128_000);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Default model references
  // --------------------------------------------------------------------------
  describe('default model references', () => {
    it('DEFAULT_PROVIDER should be a valid provider in registry', () => {
      expect(PROVIDER_REGISTRY[DEFAULT_PROVIDER]).toBeDefined();
    });

    it('DEFAULT_MODEL should exist in DEFAULT_PROVIDER models', () => {
      const provider = PROVIDER_REGISTRY[DEFAULT_PROVIDER];
      const defaultModel = provider.models.find(m => m.id === DEFAULT_MODEL);
      expect(defaultModel).toBeDefined();
    });

    it('DEFAULT_MODELS.vision should exist in some provider', () => {
      const found = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .find(m => m.id === DEFAULT_MODELS.vision);
      expect(found).toBeDefined();
      expect(found?.supportsVision).toBe(true);
    });

    it('DEFAULT_MODELS.quick should exist and be fast/free', () => {
      const found = Object.values(PROVIDER_REGISTRY)
        .flatMap(p => p.models)
        .find(m => m.id === DEFAULT_MODELS.quick);
      expect(found).toBeDefined();
      expect(found?.costType).toBe('free');
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableModels
  // --------------------------------------------------------------------------
  describe('getAvailableModels', () => {
    it('should return a flat list of all models across all providers', () => {
      const models = getAvailableModels();
      expect(models.length).toBeGreaterThan(10);

      // Check structure
      for (const entry of models) {
        expect(entry.provider).toBeTruthy();
        expect(entry.providerName).toBeTruthy();
        expect(entry.model).toBeTruthy();
        expect(entry.modelName).toBeTruthy();
      }
    });

    it('should include models from multiple providers', () => {
      const models = getAvailableModels();
      const providers = new Set(models.map(m => m.provider));
      expect(providers.size).toBeGreaterThanOrEqual(5);
    });

    it('should have unique model entries per provider', () => {
      const models = getAvailableModels();
      const seen = new Set<string>();
      for (const entry of models) {
        const key = `${entry.provider}/${entry.model}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Fallback chain integrity
  // --------------------------------------------------------------------------
  describe('fallback chain references', () => {
    it('fallback chain models should exist in PROVIDER_REGISTRY', () => {
      const missing: string[] = [];
      for (const [source, chain] of Object.entries(PROVIDER_FALLBACK_CHAIN)) {
        for (const fallback of chain) {
          const provider = PROVIDER_REGISTRY[fallback.provider];
          if (!provider) {
            missing.push(`${source} → ${fallback.provider} (provider not found)`);
            continue;
          }
          const model = provider.models.find(m => m.id === fallback.model);
          if (!model) {
            missing.push(`${source} → ${fallback.provider}/${fallback.model} (model not found)`);
          }
        }
      }
      expect(missing, `Missing fallback targets:\n${missing.join('\n')}`).toEqual([]);
    });
  });
});
