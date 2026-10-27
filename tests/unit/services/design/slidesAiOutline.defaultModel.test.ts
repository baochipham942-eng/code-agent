// AI 大纲的默认模型解析：用户配置的 models.default 优先，未配置才落出厂默认。
// 付费调用不真发——ModelRouter 与 configService 全部替身，只断言 inference 收到的 config。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string; baseUrl?: string }>,
    },
  },
  inference: vi.fn(async (_messages: unknown, _tools: unknown, _config: unknown) => ({
    content: '# 封面标题\n\n## 第一页\n- 要点一\n- 要点二\n- 要点三',
  })),
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => 'test-key',
  }),
}));

vi.mock('../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    inference(messages: unknown, tools: unknown, config: unknown) {
      return h.inference(messages, tools, config);
    }
  },
}));

import { buildAiOutline } from '../../../../src/host/services/design/slidesAiOutline';

function inferenceConfig(): Record<string, unknown> {
  const config = h.inference.mock.calls[0]?.[2];
  if (!config || typeof config !== 'object') throw new Error('inference not called');
  return config as Record<string, unknown>;
}

describe('buildAiOutline default model', () => {
  beforeEach(() => {
    h.inference.mockClear();
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  it('generates on the configured user provider and model', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.test/v1' } };

    const result = await buildAiOutline('行业趋势', 5);

    expect(result.ai).toBe(true);
    expect(inferenceConfig()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.test/v1',
      temperature: 0.7,
      maxTokens: 2048,
    });
  });

  it('generates on the factory default when nothing is configured', async () => {
    const result = await buildAiOutline('行业趋势', 5);

    expect(result.ai).toBe(true);
    expect(inferenceConfig()).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS.chat,
      temperature: 0.7,
      maxTokens: 2048,
    });
  });
});
