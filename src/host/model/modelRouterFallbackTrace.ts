import type { ModelFallbackTraceStep } from '../../shared/contract';
import { buildModelProviderIdentity } from './modelDecision';
import { getConfigService } from '../services/core/configService';
import { formatFallbackReason } from './modelRouterPolicy';

export function fallbackTargetLabel(provider: string, model?: string): string {
  return model ? `${provider}/${model}` : provider;
}

export function getFallbackProviderIdentity(provider: string): ModelFallbackTraceStep['providerIdentity'] {
  try {
    return buildModelProviderIdentity(provider, getConfigService().getSettings().models?.providers);
  } catch {
    return undefined;
  }
}

export function fallbackTraceStep(
  provider: string,
  model: string | undefined,
  status: ModelFallbackTraceStep['status'],
  reason: string,
  category?: string,
  detail?: string,
): ModelFallbackTraceStep {
	return {
	  provider,
	  ...(model ? { model } : {}),
	  ...(getFallbackProviderIdentity(provider) ? { providerIdentity: getFallbackProviderIdentity(provider) } : {}),
	  status,
    reason,
    ...(category ? { category } : {}),
    ...(detail ? { detail: formatFallbackReason(detail) } : {}),
  };
}
