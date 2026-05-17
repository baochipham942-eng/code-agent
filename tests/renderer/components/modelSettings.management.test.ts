import { describe, expect, it } from 'vitest';
import type { ModelConfig, ModelProviderSettings } from '../../../src/shared/contract';
import type { ProviderInfo } from '../../../src/shared/constants';
import {
  buildManualModelSettings,
  buildProviderManagementRows,
  createCustomProviderId,
  getModelLabel,
  hasCustomEndpointOverride,
  orderProviderManagementRows,
  resolveModelForProvider,
} from '../../../src/renderer/components/features/settings/tabs/ModelSettings';

const openaiProvider = {
  id: 'openai',
  name: 'OpenAI',
  description: 'OpenAI API',
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', evalEligible: false },
  ],
} satisfies ProviderInfo;

const moonshotProvider = {
  id: 'moonshot',
  name: 'Kimi',
  description: 'Moonshot API',
  models: [
    { id: 'kimi-k2.5', label: 'Kimi K2.5' },
    { id: 'kimi-k2.6', label: 'Kimi K2.6' },
  ],
} satisfies ProviderInfo;

const config = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  apiKey: 'sk-test',
  temperature: 0.7,
} satisfies ModelConfig;

describe('ModelSettings management helpers', () => {
  it('resolves provider default model when switching providers', () => {
    expect(resolveModelForProvider(openaiProvider, 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(resolveModelForProvider(openaiProvider, 'kimi-k2.5')).toBe('gpt-5.5');
    expect(resolveModelForProvider(moonshotProvider, 'gpt-5.5')).toBe('kimi-k2.5');
  });

  it('builds provider management rows from the catalog and current config', () => {
    const providerConfigs: Partial<Record<ModelConfig['provider'], ModelProviderSettings>> = {
      openai: {
        enabled: true,
        models: {
          'gpt-5.5': { enabled: true },
          'gpt-5.4-mini': { enabled: false },
        },
      },
    };
    const rows = buildProviderManagementRows({
      providers: [openaiProvider, moonshotProvider],
      config,
      providerConfigs,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'openai',
      selected: true,
      modelCount: 2,
      enabledModelCount: 1,
      evalEligibleCount: 1,
      defaultModel: 'gpt-5.5',
      selectedModelLabel: 'GPT-5.4 Mini',
    });
    expect(rows[1]).toMatchObject({
      id: 'moonshot',
      selected: false,
      selectedModelLabel: 'Kimi K2.5',
    });
  });

  it('keeps the selected provider at the top of the management list', () => {
    const rows = buildProviderManagementRows({
      providers: [moonshotProvider, openaiProvider],
      config,
      providerConfigs: {},
    });

    expect(orderProviderManagementRows(rows).map((row) => row.id)).toEqual(['openai', 'moonshot']);
  });

  it('falls back to raw model id when a label is unavailable', () => {
    expect(getModelLabel(openaiProvider.models, 'gpt-5.5')).toBe('GPT-5.5');
    expect(getModelLabel(openaiProvider.models, 'unknown-model')).toBe('unknown-model');
  });

  it('prefers enabled discovered models for custom providers', () => {
    const customProvider = {
      id: 'custom',
      name: 'Custom Provider',
      description: 'OpenAI compatible',
      models: [{ id: 'custom-model', label: 'Custom Model' }],
    } satisfies ProviderInfo;
    const customConfig = {
      provider: 'custom',
      model: 'mimo-v2.5-pro',
      apiKey: 'sk-test',
    } satisfies ModelConfig;
    const providerConfigs: Partial<Record<ModelConfig['provider'], ModelProviderSettings>> = {
      custom: {
        enabled: true,
        displayName: 'mimo',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        models: {
          'custom-model': { enabled: false },
          'mimo-v2.5-pro': {
            enabled: true,
            label: 'mimo-v2.5-pro',
            capabilities: ['general', 'reasoning', 'longContext'],
          },
        },
      },
    };

    expect(resolveModelForProvider(customProvider, 'missing-model', providerConfigs.custom)).toBe('mimo-v2.5-pro');

    const [row] = buildProviderManagementRows({
      providers: [customProvider],
      config: customConfig,
      providerConfigs,
    });
    expect(row).toMatchObject({
      id: 'custom',
      name: 'mimo',
      modelCount: 2,
      enabledModelCount: 1,
      endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1',
      selectedModelLabel: 'mimo-v2.5-pro',
    });
  });

  it('builds enabled manual model settings from a raw model id', () => {
    expect(buildManualModelSettings(' glm-5-thinking-vision ', '', 12345)).toMatchObject({
      label: 'glm-5-thinking-vision',
      enabled: true,
      capabilities: expect.arrayContaining(['general', 'reasoning', 'vision']),
      supportsTool: true,
      supportsVision: true,
      supportsStreaming: true,
      discoveredAt: 12345,
    });
  });

  it('creates stable unique ids for custom providers', () => {
    expect(createCustomProviderId('LongCat API', [])).toBe('custom-longcat-api');
    expect(createCustomProviderId('LongCat API', ['custom-longcat-api'])).toBe('custom-longcat-api-2');
  });

  it('detects when a built-in provider endpoint was changed to a relay', () => {
    expect(hasCustomEndpointOverride('openai', 'https://relay.example.com/v1')).toBe(true);
    expect(hasCustomEndpointOverride('openai', 'https://api.openai.com/v1/')).toBe(false);
    expect(hasCustomEndpointOverride('custom', 'https://relay.example.com/v1')).toBe(false);
    expect(hasCustomEndpointOverride('custom-relay', 'https://relay.example.com/v1')).toBe(false);
  });
});
