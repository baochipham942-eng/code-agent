// ============================================================================
// Provider Registry - 模型能力注册表
// ============================================================================

import type { ProviderConfig } from '../../shared/contract';
import { ADDITIONAL_PROVIDER_REGISTRY } from './providerRegistryAdditional';
import { BASE_PROVIDER_REGISTRY } from './providerRegistryBase';
import { applyProviderRegistryPatches } from './providerRegistryPatches';
import { resolveModelThinkingCapability } from './providerRuntimeCapabilities';

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  ...BASE_PROVIDER_REGISTRY,
  ...ADDITIONAL_PROVIDER_REGISTRY,
};

applyProviderRegistryPatches(PROVIDER_REGISTRY);

for (const provider of Object.values(PROVIDER_REGISTRY)) {
  for (const model of provider.models) {
    model.thinking = resolveModelThinkingCapability(provider.id, model.thinking);
  }
}

/**
 * E4: 获取所有可用模型（provider + model 列表）
 */
export function getAvailableModels(): Array<{ provider: string; providerName: string; model: string; modelName: string }> {
  const result: Array<{ provider: string; providerName: string; model: string; modelName: string }> = [];
  for (const [, config] of Object.entries(PROVIDER_REGISTRY)) {
    for (const model of config.models) {
      result.push({
        provider: config.id,
        providerName: config.name,
        model: model.id,
        modelName: model.name,
      });
    }
  }
  return result;
}
