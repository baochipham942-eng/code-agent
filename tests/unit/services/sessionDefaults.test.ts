import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProviderSettings } from '../../../src/shared/contract/settings';

const settingsState = vi.hoisted(() => ({
  settings: {
    models: {
      default: 'xiaomi',
      defaultProvider: 'xiaomi',
      providers: {
        xiaomi: { enabled: true, model: 'mimo-v2.5-pro' } as ModelProviderSettings,
        claude: { enabled: true } as ModelProviderSettings,
      },
      routing: {
        code: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
        vision: { provider: 'zhipu', model: 'glm-4.6v' },
        fast: { provider: 'zhipu', model: 'glm-4.7-flash' },
        gui: { provider: 'zhipu', model: 'glm-4.6v-flash' },
      },
    },
  },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => settingsState.settings,
    getApiKey: vi.fn(() => 'mock-key'),
  }),
}));

import { resolveSessionDefaultModelConfig } from '../../../src/host/services/core/sessionDefaults';

describe('resolveSessionDefaultModelConfig', () => {
  beforeEach(() => {
    settingsState.settings.models.default = 'xiaomi';
    settingsState.settings.models.defaultProvider = 'xiaomi';
    settingsState.settings.models.providers.xiaomi = { enabled: true, model: 'mimo-v2.5-pro' };
    settingsState.settings.models.providers.claude = { enabled: true };
  });

  it('uses the model output limit when maxTokens is not explicitly configured', () => {
    const config = resolveSessionDefaultModelConfig();

    expect(config.provider).toBe('xiaomi');
    expect(config.model).toBe('mimo-v2.5-pro');
    expect(config.maxTokens).toBe(131072);
  });

  it('preserves an explicit provider maxTokens override', () => {
    settingsState.settings.models.providers.xiaomi.maxTokens = 32768;

    const config = resolveSessionDefaultModelConfig();

    expect(config.maxTokens).toBe(32768);
  });

  it('falls back to the selected provider default model when provider model is missing', () => {
    settingsState.settings.models.default = 'claude';
    settingsState.settings.models.defaultProvider = 'claude';
    settingsState.settings.models.providers.claude = { enabled: true };

    const config = resolveSessionDefaultModelConfig();

    expect(config.provider).toBe('claude');
    expect(config.model).toBe('claude-opus-4-7');
  });

  it('P1a: 无参数解析取 settings.models（复数，运行真源），忽略 settings.model（单数旧字段）', () => {
    // 会话记录路径改为无参数调用，与运行路径 resolveModelConfig 同源。旧代码把单数
    // settings.model 当 args 传进来会覆盖复数默认，导致记录的模型≠实际运行（真机 dogfood P1a）。
    settingsState.settings.models.defaultProvider = 'xiaomi';
    (settingsState.settings as Record<string, unknown>).model = {
      provider: 'deepseek',
      model: 'deepseek-chat',
    };

    const config = resolveSessionDefaultModelConfig();

    expect(config.provider).toBe('xiaomi');
    expect(config.model).toBe('mimo-v2.5-pro');

    delete (settingsState.settings as Record<string, unknown>).model;
  });

  it('custom provider without model falls back to that provider\'s first listed model, not DEFAULT_MODELS.chat', () => {
    settingsState.settings.models.default = 'custom-team-relay';
    settingsState.settings.models.defaultProvider = 'custom-team-relay';
    (settingsState.settings.models.providers as Record<string, ModelProviderSettings>)['custom-team-relay'] = {
      enabled: true,
      apiKeyConfigured: true,
      models: {
        'gpt-5.5': { enabled: true },
        'gpt-5.4-mini': { enabled: true },
      },
    };

    const config = resolveSessionDefaultModelConfig();

    expect(config.provider).toBe('custom-team-relay');
    expect(config.model).toBe('gpt-5.5');
    expect(config.model).not.toBe('LongCat-2.0');
  });

  it('provider with an explicit model keeps that model', () => {
    const config = resolveSessionDefaultModelConfig();
    expect(config.provider).toBe('xiaomi');
    expect(config.model).toBe('mimo-v2.5-pro');
  });

  it('uses models.default when the legacy defaultProvider alias disagrees', () => {
    settingsState.settings.models.default = 'xiaomi';
    settingsState.settings.models.defaultProvider = 'claude';

    const config = resolveSessionDefaultModelConfig();

    expect(config.provider).toBe('xiaomi');
    expect(config.model).toBe('mimo-v2.5-pro');
  });
});
