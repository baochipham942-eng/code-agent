// Absolute compaction trigger. Default follows the model window; a stored
// 100_000 is the pre-window default (10% of a 1M window), not a user choice,
// unless triggerTokensExplicit is set.
//
// Derived ceiling reserves one full reply:
//   min(floor(window × occupancy), window − maxOutput − margin)
// and never falls below half the window or to a non-positive value.
// An explicit trigger still wins when it is lower. It cannot raise the line
// above that ceiling, so a value stored for a larger window cannot sit past
// the model that is running now.

import { PIPELINE_AUTOCOMPACT_OCCUPANCY } from './compactionOccupancy';

const LEGACY_FIXED_TRIGGER_TOKENS = 100_000;

/** Tokens kept free beyond the model's max output so the reply is not flush with the window. */
const AUTOCOMPACT_OUTPUT_RESERVE_MARGIN = 1_024;

/** Derived trigger cannot drop below this fraction of the window. */
const AUTOCOMPACT_TRIGGER_FLOOR_RATIO = 0.5;

function usableMaxOutputTokens(maxOutputTokens: number | undefined): number | undefined {
  if (typeof maxOutputTokens !== 'number' || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return undefined;
  }
  return maxOutputTokens;
}

/** Window-derived autocompact ceiling. 0 means the window itself is unusable. */
function derivedTriggerCeiling(contextWindow: number, maxOutputTokens?: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;

  const occupancyLine = Math.floor(contextWindow * PIPELINE_AUTOCOMPACT_OCCUPANCY);
  const outputBudget = usableMaxOutputTokens(maxOutputTokens);
  if (outputBudget === undefined) return occupancyLine;

  const reserveLine = Math.floor(contextWindow - outputBudget - AUTOCOMPACT_OUTPUT_RESERVE_MARGIN);
  const floorLine = Math.floor(contextWindow * AUTOCOMPACT_TRIGGER_FLOOR_RATIO);
  return Math.max(floorLine, 1, Math.min(occupancyLine, reserveLine));
}

export function resolveTriggerTokens(
  contextWindow: number,
  explicitTriggerTokens?: number,
  maxOutputTokens?: number,
): number {
  const ceiling = derivedTriggerCeiling(contextWindow, maxOutputTokens);
  if (
    typeof explicitTriggerTokens === 'number'
    && Number.isFinite(explicitTriggerTokens)
    && explicitTriggerTokens > 0
  ) {
    const explicit = Math.round(explicitTriggerTokens);
    // No positive window ceiling to apply (invalid window): keep the explicit value.
    if (ceiling <= 0) return explicit;
    return Math.min(explicit, ceiling);
  }
  return ceiling;
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
