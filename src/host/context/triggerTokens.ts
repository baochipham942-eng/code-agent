// Absolute compaction trigger. Default follows the model window; a stored
// 100_000 is the pre-window default (10% of a 1M window), not a user choice,
// unless triggerTokensExplicit is set.

import { PIPELINE_AUTOCOMPACT_OCCUPANCY } from './compactionOccupancy';

const LEGACY_FIXED_TRIGGER_TOKENS = 100_000;

export function resolveTriggerTokens(
  contextWindow: number,
  explicitTriggerTokens?: number,
): number {
  if (
    typeof explicitTriggerTokens === 'number'
    && Number.isFinite(explicitTriggerTokens)
    && explicitTriggerTokens > 0
  ) {
    return Math.round(explicitTriggerTokens);
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.floor(contextWindow * PIPELINE_AUTOCOMPACT_OCCUPANCY);
}

export function storedTriggerTokens(config: {
  triggerTokens?: number;
  triggerTokensExplicit?: boolean;
}): number | undefined {
  if (config.triggerTokensExplicit === false) return undefined;
  const raw = config.triggerTokens;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  if (config.triggerTokensExplicit !== true && raw === LEGACY_FIXED_TRIGGER_TOKENS) return undefined;
  return raw;
}
