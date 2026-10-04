import type { ModelConfig, ModelReasoningEffort } from '../../../../shared/contract/model';
import type { EffortLevel } from '../../../../shared/contract/agent';
import { normalizeAgentEffortLevel } from '../../../../shared/effortLevels';
import { explicitlyDeclaredEffortLevels } from '../../../model/providerRegistry';

const EFFORT_TO_BUDGET: Record<EffortLevel, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
  ultra_code: 49152,
};

const EFFORT_TO_REASONING_EFFORT: Record<EffortLevel, ModelReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
  ultra_code: 'high',
};

function isCatalogueEffort(level: EffortLevel): level is ModelReasoningEffort {
  return level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh' || level === 'max';
}

function reasoningEffortForModel(config: ModelConfig, normalizedEffort: EffortLevel): ModelReasoningEffort {
  const clamped = EFFORT_TO_REASONING_EFFORT[normalizedEffort];
  if (!isCatalogueEffort(normalizedEffort)) return clamped;
  const declared = explicitlyDeclaredEffortLevels(config.provider, config.model);
  if (!declared?.includes(normalizedEffort)) return clamped;
  return normalizedEffort;
}

export function applyEffortControls(
  config: ModelConfig,
  effortLevel: EffortLevel,
  options: { thinkingEnabled?: boolean } = {},
): ModelConfig {
  const normalizedEffort = normalizeAgentEffortLevel(effortLevel);
  if (options.thinkingEnabled === false) {
    return {
      ...config,
      thinkingBudget: undefined,
      reasoningEffort: undefined,
    };
  }

  const budgetForEffort = EFFORT_TO_BUDGET[normalizedEffort];
  const reasoningEffortForProvider = reasoningEffortForModel(config, normalizedEffort);

  if (
    (!budgetForEffort || config.thinkingBudget)
    && (config.reasoningEffort || !reasoningEffortForProvider)
  ) {
    return config;
  }

  return {
    ...config,
    ...(budgetForEffort && !config.thinkingBudget
      ? { thinkingBudget: budgetForEffort }
      : {}),
    ...(!config.reasoningEffort && reasoningEffortForProvider
      ? { reasoningEffort: reasoningEffortForProvider }
      : {}),
  };
}
