import type { ModelConfig } from '../../../../shared/contract/model';
import type { EffortLevel } from '../../../../shared/contract/agent';
import { normalizeAgentEffortLevel } from '../../../../shared/effortLevels';

const EFFORT_TO_BUDGET: Record<EffortLevel, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
  ultra_code: 49152,
};

const EFFORT_TO_REASONING_EFFORT: Record<EffortLevel, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
  ultra_code: 'high',
};

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
  const reasoningEffortForProvider = EFFORT_TO_REASONING_EFFORT[normalizedEffort];

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
