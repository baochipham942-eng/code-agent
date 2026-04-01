// ============================================================================
// CompressionModelRouter
// ============================================================================
// Selects the cheapest appropriate model for each compression layer.
// L1-L3 and L6 layers are model-free (rule-based); L4/L5 require a model.
// ============================================================================

export interface CompressionModelConfig {
  provider: string;
  model: string;
}

export interface CompressionModelRouterConfig {
  userPreference?: CompressionModelConfig;
}

const LAYER_MODEL_DEFAULTS: Record<string, CompressionModelConfig> = {
  contextCollapse: { provider: 'zhipu', model: 'glm-4-flash' },
  autocompact: { provider: 'moonshot', model: 'kimi-k2.5' },
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
