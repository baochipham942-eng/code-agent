import type { ModelConfig, ModelProvider } from '../../../shared/contract/model';
import type { NeoModelIntent } from '../../../shared/contract/tag';
import type { ConfigService } from '../core/configService';
import { getDefaultModelByProvider } from '../../agent/orchestrator/modelConfigResolver';

export interface ResolveNeoTagModelIntentInput {
  baseConfig: ModelConfig;
  modelIntent: NeoModelIntent;
  configService?: Pick<ConfigService, 'getApiKey' | 'getSettings'>;
}

export interface ResolvedNeoTagModelIntent {
  modelConfig: ModelConfig;
  fixedModel: boolean;
}

function providerConfigFor(
  configService: ResolveNeoTagModelIntentInput['configService'],
  provider: string,
) {
  const settings = configService?.getSettings();
  return settings?.models?.providers?.[provider];
}

function withProviderCredentials(
  config: ModelConfig,
  provider: string,
  configService: ResolveNeoTagModelIntentInput['configService'],
): ModelConfig {
  const settings = providerConfigFor(configService, provider);
  return {
    ...config,
    apiKey: configService?.getApiKey(provider as ModelProvider) || config.apiKey,
    baseUrl: settings?.baseUrl || config.baseUrl,
    protocol: settings?.protocol || config.protocol,
    maxTokens: settings?.maxTokens ?? config.maxTokens,
  };
}

export function resolveNeoTagModelIntent(
  input: ResolveNeoTagModelIntentInput,
): ResolvedNeoTagModelIntent {
  const { baseConfig, modelIntent, configService } = input;

  if (modelIntent.mode === 'inherit_current') {
    return { modelConfig: { ...baseConfig }, fixedModel: false };
  }

  if (modelIntent.mode === 'adaptive_auto') {
    const provider = modelIntent.provider || baseConfig.provider;
    const model = modelIntent.model || baseConfig.model || getDefaultModelByProvider(provider);
    const config = withProviderCredentials(
      {
        ...baseConfig,
        provider: provider as ModelProvider,
        model,
        adaptive: true,
      },
      provider,
      configService,
    );
    return { modelConfig: config, fixedModel: false };
  }

  const config = withProviderCredentials(
    {
      ...baseConfig,
      provider: modelIntent.provider as ModelProvider,
      model: modelIntent.model,
      adaptive: false,
    },
    modelIntent.provider,
    configService,
  );
  return { modelConfig: config, fixedModel: true };
}
