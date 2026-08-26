import type { ModelProvider } from './contract/model';

export interface ConfiguredModelDefaults {
  default?: string;
  defaultProvider?: ModelProvider | string;
}

/**
 * `models.default` is the persisted source of truth. `defaultProvider` remains
 * a compatibility alias for older configs and must never override `default`.
 */
export function resolveConfiguredDefaultProvider(
  models: ConfiguredModelDefaults | null | undefined,
  fallback: ModelProvider,
): ModelProvider {
  const configuredDefault = models?.default?.trim();
  if (configuredDefault) return configuredDefault as ModelProvider;

  const legacyDefault = models?.defaultProvider?.trim();
  return legacyDefault ? legacyDefault as ModelProvider : fallback;
}
