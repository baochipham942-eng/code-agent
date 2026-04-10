// ============================================================================
// ProviderStatusNotice - Listens for provider fallback events and shows toast
// ============================================================================

import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS, type ProviderFallbackEvent } from '@shared/ipc';

/**
 * Headless component that subscribes to provider_fallback events
 * and displays a toast notification when the model router falls back.
 */
export function ProviderStatusNotice(): null {
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.PROVIDER_FALLBACK,
      (event: ProviderFallbackEvent) => {
        const fromLabel = `${event.from.provider}/${event.from.model}`;
        const toLabel = `${event.to.provider}/${event.to.model}`;
        toast.info(`${fromLabel} 响应超时，已自动切换到 ${toLabel} 继续任务`);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  return null;
}
