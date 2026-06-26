// ============================================================================
// Model Capability Lookup
// ============================================================================

import type { ModelProvider } from '../../shared/contract';
import { modelHasCapability, type ModelDomainCapability } from '../../shared/constants';
import { getConfigService } from '../services/core/configService';
import { PROVIDER_REGISTRY } from './providerRegistry';

export interface ModelCandidate {
  provider: string;
  model: string;
}

export function findCapableModels(capability: ModelDomainCapability): ModelCandidate[] {
  const cfg = getConfigService();
  const candidates: ModelCandidate[] = [];
  for (const [providerId, providerConfig] of Object.entries(PROVIDER_REGISTRY)) {
    for (const model of providerConfig.models) {
      if (modelHasCapability(model.id, capability)) {
        candidates.push({ provider: providerId, model: model.id });
      }
    }
  }
  candidates.sort((a, b) => {
    const aHasKey = cfg.getApiKey(a.provider as ModelProvider) !== undefined ? 0 : 1;
    const bHasKey = cfg.getApiKey(b.provider as ModelProvider) !== undefined ? 0 : 1;
    if (aHasKey !== bHasKey) return aHasKey - bHasKey;
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.model.localeCompare(b.model);
  });
  return candidates;
}
