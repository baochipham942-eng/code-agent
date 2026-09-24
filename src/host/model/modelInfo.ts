import type { ModelInfo } from '../../shared/contract';
import { getModelMaxOutputTokens } from '../../shared/constants';
import { getConfigService } from '../services/core/configService';
import { PROVIDER_REGISTRY } from './providerRegistry';

/** Resolve the same catalog and user-configured capabilities for both engines. */
export function resolveModelInfo(provider: string, modelId: string): ModelInfo | null {
  const registered = PROVIDER_REGISTRY[provider]?.models.find((model) => model.id === modelId);
  if (registered) return registered;
  try {
    const configured = getConfigService().getSettings().models?.providers?.[provider]?.models?.[modelId];
    if (!configured) return null;
    return {
      id: modelId,
      name: configured.label ?? modelId,
      capabilities: configured.capabilities ?? [],
      maxTokens: getModelMaxOutputTokens(modelId, provider, configured.maxTokens),
      supportsTool: configured.supportsTool !== false,
      supportsVision: configured.supportsVision === true,
      supportsStreaming: configured.supportsStreaming !== false,
    };
  } catch {
    return null;
  }
}
