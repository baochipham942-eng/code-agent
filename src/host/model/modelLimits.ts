// ============================================================================
// Provider-scoped model limits
// ============================================================================
// settings.models.providers[provider].models[model] is the runtime truth for
// discovered/configured models. Shared constants remain a pure fallback layer.

import {
  getContextWindow,
  getModelMaxOutputTokens,
} from '../../shared/constants';
import { getConfigService } from '../services/core/configService';

type ModelLimitSettings = {
  contextWindow?: number;
  maxTokens?: number;
};

function getConfiguredModelLimits(provider: string | undefined, model: string): ModelLimitSettings | undefined {
  if (!provider) return undefined;
  try {
    return getConfigService().getSettings().models?.providers?.[provider]?.models?.[model];
  } catch {
    // ConfigService is intentionally optional for isolated startup/tests.
    return undefined;
  }
}

export function resolveContextWindow(model: string, provider?: string): number {
  const configured = getConfiguredModelLimits(provider, model);
  return getContextWindow(model, provider, configured?.contextWindow);
}

export function resolveModelMaxOutputTokens(model: string, provider?: string): number {
  const configured = getConfiguredModelLimits(provider, model);
  return getModelMaxOutputTokens(model, provider, configured?.maxTokens);
}
