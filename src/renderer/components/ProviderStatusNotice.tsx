// ============================================================================
// ProviderStatusNotice - Listens for provider fallback events and shows toast
// ============================================================================

import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS, type ProviderFallbackEvent } from '@shared/ipc';
import type { ModelFallbackStrategy } from '@shared/contract';
import { useI18n } from '../hooks/useI18n';
import type { Translations } from '../i18n';

function fallbackCategoryLabel(category: string | undefined, pf: Translations['notices']['providerFallback']): string {
  switch (category) {
    case 'timeout':
      return pf.categoryTimeout;
    case 'quota':
      return pf.categoryQuota;
    case 'auth':
      return pf.categoryAuth;
    case 'rate_limit':
      return pf.categoryRateLimit;
    case 'provider_unavailable':
      return pf.categoryProviderUnavailable;
    case 'network':
      return pf.categoryNetwork;
    case 'artifact_response':
      return pf.categoryArtifactResponse;
    case 'model':
      return pf.categoryModel;
    default:
      return pf.categoryDefault;
  }
}

function fallbackStrategyLabel(strategy: ModelFallbackStrategy | undefined, pf: Translations['notices']['providerFallback']): string | null {
  if (!strategy) return null;
  const map: Record<ModelFallbackStrategy, string> = {
    'adaptive-provider-fallback': pf.strategyProvider,
    'adaptive-capability-fallback': pf.strategyCapability,
    'adaptive-main-task-recovery': pf.strategyMainTask,
  };
  return map[strategy];
}

export function formatProviderFallbackToast(event: ProviderFallbackEvent, t: Translations): string {
  const pf = t.notices.providerFallback;
  const fromLabel = `${event.from.provider}/${event.from.model}`;
  const toLabel = `${event.to.provider}/${event.to.model}`;
  const categoryLabel = fallbackCategoryLabel(event.category, pf);
  const strategyLabel = fallbackStrategyLabel(event.strategy, pf);
  if (!strategyLabel) {
    return pf.toastNoStrategy
      .replace('{from}', fromLabel)
      .replace('{category}', categoryLabel)
      .replace('{to}', toLabel);
  }
  const action = event.strategy === 'adaptive-main-task-recovery' ? pf.actionRecovered : pf.actionSwitched;
  return pf.toastWithStrategy
    .replace('{strategy}', strategyLabel)
    .replace('{from}', fromLabel)
    .replace('{category}', categoryLabel)
    .replace('{action}', action)
    .replace('{to}', toLabel);
}

/**
 * Headless component that subscribes to provider_fallback events
 * and displays a toast notification when the model router falls back.
 */
export function ProviderStatusNotice(): null {
  const { t } = useI18n();
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.PROVIDER_FALLBACK,
      (event: ProviderFallbackEvent) => {
        toast.info(formatProviderFallbackToast(event, t));
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [t]);

  return null;
}
