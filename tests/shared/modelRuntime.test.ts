import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../src/shared/contract';
import {
  buildRuntimeModelOptions,
  getProviderRuntimeModels,
  inferModelCapabilities,
} from '../../src/shared/modelRuntime';
import { PROVIDER_MODELS_MAP } from '../../src/shared/constants';

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
});
