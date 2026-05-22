import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../src/shared/contract';
import {
  buildProviderInfoFromSettings,
  buildRuntimeModelOptions,
  getProviderRuntimeModels,
  inferModelCapabilities,
} from '../../src/shared/modelRuntime';
import { getProviderInfo, PROVIDER_MODELS_MAP } from '../../src/shared/constants';

describe('modelRuntime', () => {
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
    } as AppSettings;

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
    } as AppSettings;

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

  it('builds switcher options for dynamic custom provider ids', () => {
    const settings = {
      models: {
        default: 'custom-longcat',
        defaultProvider: 'custom-longcat',
        providers: {
          'custom-longcat': {
            enabled: true,
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
    } as AppSettings;

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
        model: 'longcat-2.0-preview',
        providerLabel: 'LongCat',
      }),
    ]);
  });

  it('keeps Claude provider defaults on Claude models', () => {
    expect(getProviderInfo('claude')?.defaultModel).toBe('claude-opus-4-7');
  });
});
