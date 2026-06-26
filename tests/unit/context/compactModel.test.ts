import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelConfig } from '../../../src/shared/contract';

const compactModelMocks = vi.hoisted(() => {
  const state = {
    fallbackConfig: null as ModelConfig | null,
    apiKeys: {} as Record<string, string | undefined>,
    settings: {
      model: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
      },
      models: {
        providers: {
          xiaomi: {
            enabled: true,
            baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
          },
          moonshot: {
            enabled: true,
            baseUrl: 'https://cn.haioi.net/v1',
          },
        },
      },
    } as Partial<AppSettings> as AppSettings,
    inference: vi.fn(async () => ({ type: 'text', content: '压缩摘要', finishReason: 'stop' })),
    getFallbackConfig: vi.fn(() => null as ModelConfig | null),
    getApiKey: vi.fn((provider: string) => state.apiKeys[provider]),
  };

  state.getFallbackConfig = vi.fn(() => state.fallbackConfig);
  return state;
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({
    getSettings: () => compactModelMocks.settings,
    getApiKey: compactModelMocks.getApiKey,
  }),
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ContextLengthExceededError: class MockContextLengthExceededError extends Error {
    readonly code = 'CONTEXT_LENGTH_EXCEEDED';
  },
  ModelRouter: class MockModelRouter {
    getFallbackConfig = compactModelMocks.getFallbackConfig;
    inference = compactModelMocks.inference;
  },
}));

import {
  compactModelSummarize,
  compactModelSummarizeWithMetadata,
  resetCompactModel,
} from '../../../src/host/context/compactModel';

describe('compactModelSummarize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompactModel();
    compactModelMocks.fallbackConfig = null;
    compactModelMocks.apiKeys = {};
    compactModelMocks.inference.mockReset();
    compactModelMocks.inference.mockResolvedValue({ type: 'text', content: '压缩摘要', finishReason: 'stop' });
    delete process.env.KIMI_K25_API_KEY;
    delete process.env.CODE_AGENT_E2E;
    delete process.env.CODE_AGENT_E2E_LOCAL_COMPACT_MODEL;
  });

  it('uses the local compact model boundary for E2E app-host smokes', async () => {
    process.env.CODE_AGENT_E2E = '1';
    process.env.CODE_AGENT_E2E_LOCAL_COMPACT_MODEL = '1';

    const result = await compactModelSummarizeWithMetadata('请压缩这段上下文', 500);

    expect(result).toMatchObject({
      metadata: {
        provider: 'acceptance',
        model: 'e2e-local-compact-model',
        useMainModel: false,
      },
    });
    expect(result.summary).toContain('E2E local compact summary');
    expect(compactModelMocks.inference).not.toHaveBeenCalled();
  });

  it('uses the selected fallback provider key instead of an unrelated service key', async () => {
    compactModelMocks.fallbackConfig = {
      provider: 'moonshot',
      model: 'kimi-k2.5',
      maxTokens: 2048,
    };
    compactModelMocks.apiKeys = {
      moonshot: 'moonshot-key',
      xiaomi: 'xiaomi-key',
      openrouter: undefined,
    };

    await expect(compactModelSummarize('请压缩这段上下文', 500)).resolves.toBe('压缩摘要');

    expect(compactModelMocks.inference).toHaveBeenCalledWith(
      [{ role: 'user', content: '请压缩这段上下文' }],
      [],
      expect.objectContaining({
        provider: 'moonshot',
        model: 'kimi-k2.5',
        apiKey: 'moonshot-key',
      })
    );
  });

  it('falls back to the main model when the compact fallback has no key', async () => {
    compactModelMocks.fallbackConfig = {
      provider: 'moonshot',
      model: 'kimi-k2.5',
      maxTokens: 2048,
    };
    compactModelMocks.apiKeys = {
      moonshot: undefined,
      xiaomi: 'xiaomi-key',
    };

    await expect(compactModelSummarize('请压缩这段上下文', 500)).resolves.toBe('压缩摘要');

    expect(compactModelMocks.inference).toHaveBeenCalledWith(
      [{ role: 'user', content: '请压缩这段上下文' }],
      [],
      expect.objectContaining({
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'xiaomi-key',
      })
    );
  });

  it('returns metadata for the actual model used by a missing-key fallback', async () => {
    compactModelMocks.fallbackConfig = {
      provider: 'moonshot',
      model: 'kimi-k2.5',
      maxTokens: 2048,
    };
    compactModelMocks.apiKeys = {
      moonshot: undefined,
      xiaomi: 'xiaomi-key',
    };

    const result = await compactModelSummarizeWithMetadata('请压缩这段上下文', 500);

    expect(result).toEqual({
      summary: '压缩摘要',
      metadata: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        useMainModel: true,
        fallbackReason: 'compact_model_missing_api_key',
      },
    });
  });

  it('retries with the main model when the compact model context window is exceeded', async () => {
    compactModelMocks.fallbackConfig = {
      provider: 'moonshot',
      model: 'kimi-k2.5',
      maxTokens: 2048,
    };
    compactModelMocks.apiKeys = {
      moonshot: 'moonshot-key',
      xiaomi: 'xiaomi-key',
    };
    compactModelMocks.inference
      .mockRejectedValueOnce(Object.assign(new Error('maximum context length exceeded'), {
        code: 'CONTEXT_LENGTH_EXCEEDED',
        name: 'ContextLengthExceededError',
      }))
      .mockResolvedValueOnce({ type: 'text', content: '主模型压缩摘要', finishReason: 'stop' });

    const result = await compactModelSummarizeWithMetadata('请压缩这段超长上下文', 500);

    expect(result).toEqual({
      summary: '主模型压缩摘要',
      metadata: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        useMainModel: true,
        fallbackReason: 'compact_context_length_exceeded',
      },
    });

    expect(compactModelMocks.inference).toHaveBeenCalledTimes(2);
    expect(compactModelMocks.inference).toHaveBeenNthCalledWith(
      1,
      [{ role: 'user', content: '请压缩这段超长上下文' }],
      [],
      expect.objectContaining({
        provider: 'moonshot',
        model: 'kimi-k2.5',
      })
    );
    expect(compactModelMocks.inference).toHaveBeenNthCalledWith(
      2,
      [{ role: 'user', content: '请压缩这段超长上下文' }],
      [],
      expect.objectContaining({
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: 'xiaomi-key',
      })
    );
  });
});
