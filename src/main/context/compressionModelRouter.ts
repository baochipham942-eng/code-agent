// ============================================================================
// CompressionModelRouter
// ============================================================================
// Selects the cheapest appropriate model for each compression layer.
// L1-L3 and L6 layers are model-free (rule-based); L4/L5 require a model.
// ============================================================================

import { AGENT_DEFAULT_MODEL, DEFAULT_MODELS } from '../../shared/constants/models';

export interface CompressionModelConfig {
  provider: string;
  model: string;
}

export interface CompressionModelRouterConfig {
  userPreference?: CompressionModelConfig;
}

const LAYER_MODEL_DEFAULTS: Record<string, CompressionModelConfig> = {
  contextCollapse: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
  autocompact: { ...AGENT_DEFAULT_MODEL },
};

const MODEL_FREE_LAYERS = new Set([
  'tool-result-budget',
  'snip',
  'microcompact',
  'overflow-recovery',
]);

export class CompressionModelRouter {
  private preference?: CompressionModelConfig;

  constructor(config?: CompressionModelRouterConfig) {
    this.preference = config?.userPreference;
  }

  selectModel(layer: string): CompressionModelConfig | null {
    if (MODEL_FREE_LAYERS.has(layer)) return null;
    if (this.preference) return this.preference;
    return LAYER_MODEL_DEFAULTS[layer] || null;
  }

  setPreference(config: CompressionModelConfig): void {
    this.preference = config;
  }

  clearPreference(): void {
    this.preference = undefined;
  }
}

let instance: CompressionModelRouter | null = null;

export function getCompressionModelRouter(): CompressionModelRouter {
  if (!instance) instance = new CompressionModelRouter();
  return instance;
}

export function resetCompressionModelRouter(): void {
  instance = null;
}
