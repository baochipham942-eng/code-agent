// ============================================================================
// ProviderStatusNotice - Listens for provider fallback events and shows toast
// ============================================================================

import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS, type ProviderFallbackEvent } from '@shared/ipc';
import type { ModelFallbackStrategy } from '@shared/contract';

function fallbackCategoryLabel(category?: string): string {
  switch (category) {
    case 'timeout':
      return '响应超时';
    case 'quota':
      return '额度或计费异常';
    case 'auth':
      return '认证失败';
    case 'rate_limit':
      return '触发限流';
    case 'provider_unavailable':
      return '服务不可用';
    case 'network':
      return '网络异常';
    case 'artifact_response':
      return 'artifact 响应不可用';
    case 'model':
      return '模型不可用';
    default:
      return '调用失败';
  }
}

const FALLBACK_STRATEGY_LABELS: Record<ModelFallbackStrategy, string> = {
  'adaptive-provider-fallback': '自动策略恢复',
  'adaptive-capability-fallback': '能力自动切换',
  'adaptive-main-task-recovery': '回到主任务模型',
};

function fallbackStrategyLabel(strategy?: ModelFallbackStrategy): string | null {
  return strategy ? FALLBACK_STRATEGY_LABELS[strategy] : null;
}

export function formatProviderFallbackToast(event: ProviderFallbackEvent): string {
  const fromLabel = `${event.from.provider}/${event.from.model}`;
  const toLabel = `${event.to.provider}/${event.to.model}`;
  const categoryLabel = fallbackCategoryLabel(event.category);
  const strategyLabel = fallbackStrategyLabel(event.strategy);
  if (!strategyLabel) {
    return `${fromLabel} ${categoryLabel}，已自动切换到 ${toLabel} 继续任务`;
  }
  const action = event.strategy === 'adaptive-main-task-recovery' ? '已回到' : '已切换到';
  return `${strategyLabel}：${fromLabel} ${categoryLabel}，${action} ${toLabel} 继续任务`;
}

/**
 * Headless component that subscribes to provider_fallback events
 * and displays a toast notification when the model router falls back.
 */
export function ProviderStatusNotice(): null {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.PROVIDER_FALLBACK,
      (event: ProviderFallbackEvent) => {
        toast.info(formatProviderFallbackToast(event));
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  return null;
}
