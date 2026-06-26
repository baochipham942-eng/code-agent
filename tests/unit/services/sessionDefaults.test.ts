import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState = vi.hoisted(() => ({
  settings: {
    models: {
      defaultProvider: 'xiaomi',
      providers: {
        xiaomi: { enabled: true, model: 'mimo-v2.5-pro' },
        claude: { enabled: true },
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
    settingsState.settings.models.defaultProvider = 'claude';
    settingsState.settings.models.providers.claude = { enabled: true };

    const config = resolveSessionDefaultModelConfig();

    expect(config.provider).toBe('claude');
    expect(config.model).toBe('claude-opus-4-7');
  });
});
