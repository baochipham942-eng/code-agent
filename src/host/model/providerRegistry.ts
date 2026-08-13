// ============================================================================
// Provider Registry - 模型能力注册表
// ============================================================================

import type { ProviderConfig } from '../../shared/contract';
import { ADDITIONAL_PROVIDER_REGISTRY } from './providerRegistryAdditional';
import { BASE_PROVIDER_REGISTRY } from './providerRegistryBase';
import { applyProviderRegistryPatches } from './providerRegistryPatches';
import { resolveModelCapabilities } from './modelCapabilityMatrix';
import { resolveModelThinkingCapability } from './providerRuntimeCapabilities';

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  ...BASE_PROVIDER_REGISTRY,
  ...ADDITIONAL_PROVIDER_REGISTRY,
};

applyProviderRegistryPatches(PROVIDER_REGISTRY);

for (const provider of Object.values(PROVIDER_REGISTRY)) {
  for (const model of provider.models) {
    model.thinking = resolveModelThinkingCapability(provider.id, model.thinking);
    // 能力矩阵 search.mode!=='none' → UI 的 'search' 能力标签在这里单源回填；
    // renderer 据此（而非第二套判断）知道这模型自带联网搜索。
    // perplexity 等手工标的 'search' 不受影响（已含则不重复加）。
    if (
      resolveModelCapabilities(provider.id, model.id).search?.mode !== 'none'
      && !model.capabilities.includes('search')
    ) {
      model.capabilities = [...model.capabilities, 'search'];
    }
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
