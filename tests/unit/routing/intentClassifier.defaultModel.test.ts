import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../../../src/host/model/modelRouter';
import { IntentClassifier } from '../../../src/host/routing/intentClassifier';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string }>,
    },
  },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

const AMBIGUOUS = '请帮我看一下这件事接下来应该怎么处理才比较稳妥一些';

describe('intentClassifier default model', () => {
  const chat = vi.fn(async (_request: unknown) => ({
    content: '{"intent":"explanation","confidence":0.8,"needs_research":false,"depth":"quick","reasoning":"test"}',
  }));

  beforeEach(() => {
    chat.mockClear();
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  async function classify(): Promise<{ provider: string; model: string; maxTokens: number }> {
    const router = { chat } as unknown as ModelRouter;
    const classifier = new IntentClassifier(router, { llmFallbackThreshold: 1 });
    await classifier.classify(AMBIGUOUS);
    expect(chat).toHaveBeenCalled();
    const request = chat.mock.calls[0]?.[0];
    if (!request || typeof request !== 'object') throw new Error('missing chat request');
    return request as { provider: string; model: string; maxTokens: number };
  }

  it('uses the configured user provider and model', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    await expect(classify()).resolves.toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 150,
    });
  });

  it('falls back to the factory default when nothing is configured', async () => {
    await expect(classify()).resolves.toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      maxTokens: 150,
    });
  });
});
