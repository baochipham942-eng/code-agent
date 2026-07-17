import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../src/shared/contract';
import {
  PROVIDER_ICON_ASSET_URI_PREFIX,
  PROVIDER_ICON_IMAGE_MAX_BYTES,
  buildProviderInfoFromSettings,
  buildRuntimeModelOptions,
  estimateProviderIconImageBytes,
  getProviderIconAssetFilename,
  getProviderIconPresets,
  getProviderRuntimeModels,
  groupRuntimeModelOptionsByProvider,
  hasConfiguredDefaultRuntimeModel,
  hasConfiguredRuntimeModels,
  inferModelCapabilities,
  isProviderIconAssetRef,
  isProviderImageIcon,
  isRuntimeProviderAvailable,
  normalizeProviderIcon,
  resolveRuntimeProviderBillingMode,
  validateProviderIcon,
} from '../../src/shared/modelRuntime';
import { getModelDisplayLabel, getProviderInfo, PROVIDER_MODELS_MAP } from '../../src/shared/constants';

describe('modelRuntime', () => {
  const tinyPngIcon = 'data:image/png;base64,aGVsbG8=';

  it('infers useful default capabilities from discovered model ids', () => {
    expect(inferModelCapabilities('mimo-v2.5-pro-1m')).toEqual(
      expect.arrayContaining(['general', 'longContext'])
    );
    expect(inferModelCapabilities('glm-5-thinking-vision')).toEqual(
      expect.arrayContaining(['general', 'reasoning', 'vision'])
    );
  });

  it('hides disabled models and exposes enabled custom models to switcher options', () => {
    const settings = {
      models: {
        default: 'custom',
        defaultProvider: 'custom',
        providers: {
          custom: {
            enabled: true,
            apiKeyConfigured: true,
            displayName: 'mimo',
            baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
            models: {
              'custom-model': { enabled: false },
              'mimo-v2.5-pro': {
                enabled: true,
                label: 'mimo-v2.5-pro',
                capabilities: ['general', 'reasoning', 'longContext'],
                supportsTool: true,
              },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const runtimeModels = getProviderRuntimeModels(PROVIDER_MODELS_MAP.custom, settings.models.providers.custom);
    expect(runtimeModels.find((model) => model.id === 'custom-model')?.enabled).toBe(false);

    const options = buildRuntimeModelOptions(settings, ['custom']);
    expect(options).toEqual([
      expect.objectContaining({
        provider: 'custom',
        model: 'mimo-v2.5-pro',
        label: 'mimo-v2.5-pro',
        providerLabel: 'mimo',
        features: expect.arrayContaining(['tool', 'reasoning']),
      }),
    ]);
  });

  it('hides providers without a configured API key from switcher options', () => {
    const settings = {
      models: {
        default: 'deepseek',
        defaultProvider: 'deepseek',
        providers: {
          // enabled 但没配 key（默认设置里 deepseek/claude 等就是这个状态）→ 不出现
          deepseek: { enabled: true },
          claude: { enabled: true },
          // 配了 key → 出现
          moonshot: { enabled: true, apiKeyConfigured: true },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const options = buildRuntimeModelOptions(settings, ['deepseek', 'claude', 'moonshot']);
    expect(new Set(options.map((option) => option.provider))).toEqual(new Set(['moonshot']));

    // includeDisabledProviders 豁免：当前会话/默认 provider 即使没 key 也保留
    const withInclusion = buildRuntimeModelOptions(settings, ['deepseek', 'claude', 'moonshot'], {
      includeDisabledProviders: ['deepseek'],
    });
    expect(new Set(withInclusion.map((option) => option.provider))).toEqual(new Set(['deepseek', 'moonshot']));
  });

  it('hides local provider when local discovery is unavailable', () => {
    const settings = {
      models: {
        default: 'local',
        defaultProvider: 'local',
        providers: {
          local: {
            enabled: true,
            available: false,
            apiKeyConfigured: true,
            models: {
              'llama3.2': { enabled: true, label: 'Llama 3.2' },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(buildRuntimeModelOptions(settings, ['local'], {
      includeDisabledProviders: ['local'],
    })).toEqual([]);
    expect(hasConfiguredRuntimeModels(settings)).toBe(false);
    expect(isRuntimeProviderAvailable('local', settings.models.providers.local)).toBe(false);
  });

  it('keeps local enabled separate from runtime availability', () => {
    const localProvider = {
      enabled: false,
      available: true,
      apiKeyConfigured: false,
      models: {
        'llama3.2': { enabled: true, label: 'Llama 3.2', discoveredAt: 123 },
      },
    };

    expect(isRuntimeProviderAvailable('local', localProvider)).toBe(true);
    expect(buildRuntimeModelOptions({
      models: {
        default: 'local',
        defaultProvider: 'local',
        providers: { local: localProvider },
      },
    } as unknown as AppSettings, ['local'])).toEqual([]); // partial fixture, intentionally missing fields
  });

  it('shows only locally discovered Ollama models when local discovery succeeds', () => {
    const settings = {
      models: {
        default: 'local',
        defaultProvider: 'local',
        providers: {
          local: {
            enabled: true,
            available: true,
            apiKeyConfigured: false,
            models: {
              'qwen3:8b': { enabled: true, label: 'Qwen3 8B', discoveredAt: 123 },
              'llama3.2': { enabled: true, label: 'Llama 3.2', discoveredAt: 123 },
              'stale-local': { enabled: true, label: 'Stale Local' },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const options = buildRuntimeModelOptions(settings, ['local']);
    expect(options.map((option) => option.model)).toEqual(expect.arrayContaining(['qwen3:8b', 'llama3.2']));
    expect(options.map((option) => option.model)).not.toContain('stale-local');
    expect(new Set(options.map((option) => option.provider))).toEqual(new Set(['local']));
  });

  it('can include a disabled current provider in switcher options', () => {
    const settings = {
      models: {
        default: 'openai',
        defaultProvider: 'openai',
        providers: {
          openai: {
            enabled: false,
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(buildRuntimeModelOptions(settings, ['openai'])).toEqual([]);
    expect(buildRuntimeModelOptions(settings, ['openai'], {
      includeDisabledProviders: ['openai'],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.5',
      }),
    ]));
  });

  it('treats enabled providers without API keys as no configured runtime model', () => {
    const settings = {
      models: {
        default: 'xiaomi',
        defaultProvider: 'xiaomi',
        providers: {
          xiaomi: { enabled: true },
          zhipu: { enabled: true },
          local: { enabled: false },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(hasConfiguredRuntimeModels(settings)).toBe(false);
    expect(buildRuntimeModelOptions(settings, ['xiaomi'], {
      includeDisabledProviders: ['xiaomi'],
    }).length).toBeGreaterThan(0);
  });

  it('accepts stored API keys and discovered local models as configured runtime models', () => {
    const keyedSettings = {
      models: {
        default: 'xiaomi',
        defaultProvider: 'xiaomi',
        providers: {
          xiaomi: { enabled: true, apiKeyConfigured: true },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields
    const localSettings = {
      models: {
        default: 'local',
        defaultProvider: 'local',
        providers: {
          local: {
            enabled: true,
            available: true,
            apiKeyConfigured: false,
            models: {
              'llama3.2': { enabled: true, label: 'Llama 3.2', discoveredAt: 123 },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(hasConfiguredRuntimeModels(keyedSettings)).toBe(true);
    expect(hasConfiguredRuntimeModels(localSettings)).toBe(true);
  });

  it('accepts cloud-managed providers as configured without exposing keys', () => {
    const settings = {
      models: {
        default: 'custom-cloud-gpt55',
        defaultProvider: 'custom-cloud-gpt55',
        providers: {
          'custom-cloud-gpt55': {
            enabled: true,
            managedByCloud: true,
            displayName: 'Cloud GPT-5.5',
            protocol: 'openai',
            baseUrl: 'https://relay.example.com/openai',
            model: 'gpt-5.5',
            models: {
              'gpt-5.5': { enabled: true, label: 'GPT-5.5' },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(hasConfiguredRuntimeModels(settings)).toBe(true);
    expect(hasConfiguredDefaultRuntimeModel(settings)).toBe(true);
    expect(buildRuntimeModelOptions(settings)).toContainEqual(expect.objectContaining({
      model: 'gpt-5.5',
      providerProtocol: 'openai',
      providerTransportLabel: 'OpenAI-compatible',
      providerEndpoint: 'https://relay.example.com/openai',
    }));
  });

  it('requires the active default provider to be configured before send', () => {
    const settings = {
      models: {
        default: 'xiaomi',
        defaultProvider: 'xiaomi',
        providers: {
          xiaomi: { enabled: true },
          claude: { enabled: true, apiKeyConfigured: true, model: 'claude-sonnet-4-6' },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(hasConfiguredRuntimeModels(settings)).toBe(true);
    expect(hasConfiguredDefaultRuntimeModel(settings)).toBe(false);
  });

  it('uses neutral built-in model labels in the switcher catalog', () => {
    expect(getModelDisplayLabel('mimo-v2.5-pro')).toBe('MiMo v2.5 Pro');
    expect(getModelDisplayLabel('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
  });

  it('builds switcher options for dynamic custom provider ids', () => {
    const settings = {
      models: {
        default: 'custom-longcat',
        defaultProvider: 'custom-longcat',
        providers: {
          'custom-longcat': {
            enabled: true,
            apiKeyConfigured: true,
            protocol: 'claude',
            displayName: 'LongCat',
            baseUrl: 'https://api.longcat.example/v1',
            model: 'longcat-2.0-preview',
            models: {
              'longcat-2.0-preview': {
                enabled: true,
                label: 'LongCat 2.0 Preview',
                capabilities: ['general', 'code', 'longContext'],
                supportsTool: true,
              },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const provider = buildProviderInfoFromSettings('custom-longcat', settings.models.providers['custom-longcat']);
    expect(provider).toMatchObject({
      id: 'custom-longcat',
      name: 'LongCat',
      description: 'Claude-compatible · https://api.longcat.example/v1',
      models: [{ id: 'longcat-2.0-preview', label: 'LongCat 2.0 Preview' }],
    });

    expect(buildRuntimeModelOptions(settings, [])).toEqual([
      expect.objectContaining({
        provider: 'custom-longcat',
        providerGroup: 'longcat',
        providerGroupLabel: 'LongCat',
        model: 'longcat-2.0-preview',
        providerLabel: 'LongCat',
      }),
    ]);
  });

  it('groups Claude-shaped custom relays under Claude even when protocol is omitted', () => {
    const settings = {
      models: {
        default: 'custom-commonstack-claude',
        defaultProvider: 'custom-commonstack-claude',
        providers: {
          'custom-commonstack-claude': {
            enabled: true,
            apiKeyConfigured: true,
            displayName: 'CommonStack Claude',
            baseUrl: 'https://commonstack.example/v1',
            model: 'anthropic/claude-opus-4-8',
            models: {
              'anthropic/claude-opus-4-8': {
                enabled: true,
                label: 'Claude Opus 4 8',
                capabilities: ['general', 'reasoning', 'vision'],
                supportsTool: true,
              },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    expect(buildRuntimeModelOptions(settings, [])).toEqual([
      expect.objectContaining({
        provider: 'custom-commonstack-claude',
        providerGroup: 'claude',
        providerGroupLabel: 'Anthropic Claude',
        providerSourceLabel: 'CommonStack',
        providerProtocol: 'openai',
        providerTransportLabel: 'OpenAI-compatible',
        providerEndpoint: 'https://commonstack.example/v1',
        model: 'anthropic/claude-opus-4-8',
      }),
    ]);
  });

  it('keeps neutral mixed custom relays under their own provider group', () => {
    const settings = {
      models: {
        default: 'custom-muyuan-do',
        defaultProvider: 'custom-muyuan-do',
        providers: {
          'custom-muyuan-do': {
            enabled: true,
            apiKeyConfigured: true,
            protocol: 'openai',
            displayName: 'muyuan.do',
            baseUrl: 'https://muyuan.do/v1',
            model: 'gpt-5.4-mini',
            models: {
              'gpt-5.4-mini': {
                enabled: true,
                label: 'gpt-5.4-mini',
                supportsTool: true,
              },
              'claude-sonnet-4-6': {
                enabled: true,
                label: 'claude-sonnet-4-6',
                supportsTool: true,
              },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const options = buildRuntimeModelOptions(settings, []);

    expect(options.map((option) => option.model)).toEqual([
      'gpt-5.4-mini',
      'claude-sonnet-4-6',
    ]);
    expect(options).toEqual([
      expect.objectContaining({
        provider: 'custom-muyuan-do',
        providerGroup: 'custom-muyuan-do',
        providerGroupLabel: 'muyuan.do',
        model: 'gpt-5.4-mini',
      }),
      expect.objectContaining({
        provider: 'custom-muyuan-do',
        providerGroup: 'custom-muyuan-do',
        providerGroupLabel: 'muyuan.do',
        model: 'claude-sonnet-4-6',
      }),
    ]);
  });

  it('keeps only the latest configured source per provider group in switcher options', () => {
    const settings = {
      models: {
        default: 'custom-commonstack-claude',
        defaultProvider: 'custom-commonstack-claude',
        providers: {
          claude: {
            enabled: true,
            apiKeyConfigured: true,
            updatedAt: 100,
          },
          'custom-scydao-claude': {
            enabled: true,
            apiKeyConfigured: true,
            displayName: 'ScyDAO Claude',
            baseUrl: 'https://scydao.example/v1',
            model: 'claude-opus-4-7-medium',
            updatedAt: 200,
            models: {
              'claude-opus-4-7-medium': {
                enabled: true,
                label: 'Claude Opus 4.7 Medium',
                supportsTool: true,
              },
            },
          },
          'custom-commonstack-claude': {
            enabled: true,
            apiKeyConfigured: true,
            displayName: 'CommonStack Claude',
            baseUrl: 'https://commonstack.example/v1',
            model: 'anthropic/claude-opus-4-8',
            updatedAt: 300,
            models: {
              'anthropic/claude-opus-4-8': {
                enabled: true,
                label: 'Claude Opus 4 8',
                supportsTool: true,
              },
              'anthropic/claude-sonnet-4-6': {
                enabled: false,
                label: 'Claude Sonnet 4 6',
                supportsTool: true,
              },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const options = buildRuntimeModelOptions(settings, ['claude']);

    expect(options.map((option) => option.provider)).toEqual([
      'custom-commonstack-claude',
      'custom-commonstack-claude',
    ]);
    expect(options).toEqual([
      expect.objectContaining({
        providerGroup: 'claude',
        providerSourceLabel: 'CommonStack',
        model: 'anthropic/claude-opus-4-8',
      }),
      expect.objectContaining({
        providerGroup: 'claude',
        providerSourceLabel: 'CommonStack',
        model: 'anthropic/claude-sonnet-4-6',
      }),
    ]);
  });

  it('lets an official provider replace relays when it has the latest provider update', () => {
    const settings = {
      models: {
        default: 'claude',
        defaultProvider: 'claude',
        providers: {
          claude: {
            enabled: true,
            apiKeyConfigured: true,
            updatedAt: 400,
          },
          'custom-commonstack-claude': {
            enabled: true,
            apiKeyConfigured: true,
            displayName: 'CommonStack Claude',
            baseUrl: 'https://commonstack.example/v1',
            model: 'anthropic/claude-opus-4-8',
            updatedAt: 300,
            models: {
              'anthropic/claude-opus-4-8': {
                enabled: true,
                label: 'Claude Opus 4 8',
                supportsTool: true,
              },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const options = buildRuntimeModelOptions(settings, ['claude']);

    expect(new Set(options.map((option) => option.provider))).toEqual(new Set(['claude']));
    expect(options).toContainEqual(expect.objectContaining({
      provider: 'claude',
      model: 'claude-opus-4-7',
    }));
  });

  it('keeps Claude provider defaults on Claude models', () => {
    expect(getProviderInfo('claude')?.defaultModel).toBe('claude-opus-4-7');
  });

  it('groups switcher options by provider without reordering models', () => {
    const groups = groupRuntimeModelOptionsByProvider([
      { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', providerLabel: 'DeepSeek', features: [] },
      { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', providerLabel: 'DeepSeek', features: ['reasoning'] },
      { provider: 'xiaomi', model: 'mimo-v2.5-pro', label: 'MiMo v2.5 Pro', providerLabel: '小米 MiMo', features: ['tool'] },
      {
        provider: 'custom-claude-relay',
        providerGroup: 'claude',
        providerGroupLabel: 'Claude',
        providerSourceLabel: 'Relay',
        providerProtocol: 'openai',
        providerTransportLabel: 'OpenAI-compatible',
        providerEndpoint: 'https://relay.example.com/v1',
        model: 'anthropic/claude-opus-4-8',
        label: 'Claude Opus 4 8',
        providerLabel: 'Relay',
        features: ['reasoning'],
      },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        provider: 'deepseek',
        providerLabel: 'DeepSeek',
        options: [
          expect.objectContaining({ model: 'deepseek-v4-flash' }),
          expect.objectContaining({ model: 'deepseek-v4-pro' }),
        ],
      }),
      expect.objectContaining({
        provider: 'xiaomi',
        providerLabel: '小米 MiMo',
        options: [expect.objectContaining({ model: 'mimo-v2.5-pro' })],
      }),
      expect.objectContaining({
        provider: 'claude',
        providerLabel: 'Claude',
        providerSourceLabel: 'Relay',
        providerProtocol: 'openai',
        providerTransportLabel: 'OpenAI-compatible',
        providerEndpoint: 'https://relay.example.com/v1',
        options: [
          expect.objectContaining({
            provider: 'custom-claude-relay',
            providerSourceLabel: 'Relay',
            providerProtocol: 'openai',
            providerTransportLabel: 'OpenAI-compatible',
            providerEndpoint: 'https://relay.example.com/v1',
            model: 'anthropic/claude-opus-4-8',
          }),
        ],
      }),
    ]);
  });

  it('carries provider icon and favorite state into switcher groups', () => {
    const groups = groupRuntimeModelOptionsByProvider([
      { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', providerLabel: 'DeepSeek', features: [] },
      {
        provider: 'moonshot',
        model: 'kimi-k2.5',
        label: 'Kimi K2.5',
        providerLabel: 'Kimi',
        providerIcon: 'KM',
        providerFavorite: true,
        features: [],
      },
    ]);

    expect(groups[0]).toMatchObject({
      provider: 'moonshot',
      providerIcon: 'KM',
      providerFavorite: true,
      options: [expect.objectContaining({ providerFavorite: true, providerIcon: 'KM' })],
    });
  });

  it('carries provider billing mode into switcher options and groups', () => {
    const settings = {
      models: {
        default: 'moonshot',
        defaultProvider: 'moonshot',
        providers: {
          moonshot: {
            enabled: true,
            apiKeyConfigured: true,
            billingMode: 'plan',
          },
          'custom-payg-relay': {
            enabled: true,
            apiKeyConfigured: true,
            billingMode: 'payg',
            displayName: 'Payg Relay',
            model: 'gpt-5.4-mini',
            models: {
              'gpt-5.4-mini': { enabled: true, label: 'GPT 5.4 mini' },
            },
          },
        },
      },
    } as unknown as AppSettings; // partial fixture, intentionally missing fields

    const options = buildRuntimeModelOptions(settings, ['moonshot']);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'moonshot',
        providerBillingMode: 'plan',
      }),
      expect.objectContaining({
        provider: 'custom-payg-relay',
        providerBillingMode: 'payg',
      }),
    ]));

    const groups = groupRuntimeModelOptionsByProvider(options);
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'moonshot',
        providerBillingMode: 'plan',
      }),
      expect.objectContaining({
        provider: 'openai',
        providerBillingMode: 'payg',
        providerSourceLabel: 'Payg Relay',
      }),
    ]));
  });

  it('defaults dynamic custom provider billing to unknown for conservative routing copy', () => {
    expect(resolveRuntimeProviderBillingMode('custom-commonstack')).toBe('unknown');
    expect(resolveRuntimeProviderBillingMode('deepseek')).toBe('payg');
  });

  it('keeps provider image data URL icons while rejecting unsupported data URLs', () => {
    expect(isProviderImageIcon(tinyPngIcon)).toBe(true);
    expect(isProviderImageIcon(`${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`)).toBe(true);
    expect(normalizeProviderIcon(tinyPngIcon)).toBe(tinyPngIcon);
    expect(normalizeProviderIcon(`${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`)).toBe(`${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`);
    expect(estimateProviderIconImageBytes(tinyPngIcon)).toBe(5);
    expect(normalizeProviderIcon('data:text/html;base64,PGgxPk5vPC9oMT4=')).toBeUndefined();
    expect(estimateProviderIconImageBytes('data:text/html;base64,PGgxPk5vPC9oMT4=')).toBeUndefined();
    expect(normalizeProviderIcon('GPT')).toBe('GP');
    expect(estimateProviderIconImageBytes('GPT')).toBeUndefined();
  });

  it('explains provider icon validation boundaries for text, unsupported data URLs, and oversized images', () => {
    expect(validateProviderIcon('GPT')).toEqual({
      valid: true,
      kind: 'text',
      normalized: 'GP',
      truncated: true,
    });
    expect(validateProviderIcon('data:text/html;base64,PGgxPk5vPC9oMT4=')).toEqual({
      valid: false,
      kind: 'invalid',
      reason: 'unsupported-data-url',
    });

    const oversizedIcon = `data:image/png;base64,${'a'.repeat(Math.ceil((PROVIDER_ICON_IMAGE_MAX_BYTES + 1) * 4 / 3))}`;
    expect(validateProviderIcon(oversizedIcon)).toMatchObject({
      valid: false,
      kind: 'invalid',
      reason: 'image-too-large',
    });
    expect(normalizeProviderIcon(oversizedIcon)).toBeUndefined();

    expect(validateProviderIcon(`${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`)).toEqual({
      valid: true,
      kind: 'asset',
      normalized: `${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`,
      filename: 'openai-abcd1234.png',
    });
    expect(isProviderIconAssetRef(`${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`)).toBe(true);
    expect(getProviderIconAssetFilename(`${PROVIDER_ICON_ASSET_URI_PREFIX}openai-abcd1234.png`)).toBe('openai-abcd1234.png');
    expect(validateProviderIcon(`${PROVIDER_ICON_ASSET_URI_PREFIX}../secret.png`)).toEqual({
      valid: false,
      kind: 'invalid',
      reason: 'unsupported-asset-ref',
    });
  });

  it('offers built-in provider icon presets and normalizes them to visible short marks', () => {
    expect(getProviderIconPresets('moonshot')).toEqual([
      { icon: 'KM', label: 'Kimi' },
      { icon: 'MS', label: 'Moonshot' },
    ]);

    expect(getProviderIconPresets('custom-relay')).toEqual([
      { icon: 'CU', label: 'Custom' },
      { icon: 'AP', label: 'API' },
      { icon: 'AI', label: 'AI' },
    ]);
  });
});
