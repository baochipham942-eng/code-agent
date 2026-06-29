// ============================================================================
// SessionExpiredNotice - 登录过期非阻塞提示（headless，复用 ProviderStatusNotice 范式）
// ============================================================================
//
// 2c(ADR-030): 曾登录但 session 不可恢复（过期/失效）时，后端置 AuthEvent.sessionExpired。
// 这里弹一条非阻塞 toast 提示重新登录——取代过去的"默默清零"（用户无感、云端遥测静默零回传）。
// 区别于主动登出：signed_out 但无 sessionExpired 时不打扰。

import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import { useI18n } from '../hooks/useI18n';
import ipcService from '../services/ipcService';
import { IPC_CHANNELS, type AuthEvent } from '@shared/ipc';

/**
 * 仅在「曾登录但 session 过期」时提示；主动登出（signed_out 无 sessionExpired）不打扰。
 * 抽成纯函数便于单测（沿用 ProviderStatusNotice 范式）。
 */
export function shouldShowSessionExpiredToast(event: AuthEvent): boolean {
  return event.type === 'signed_out' && event.sessionExpired === true;
}

export function SessionExpiredNotice(): null {
  const { t } = useI18n();
  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.AUTH_EVENT, (event: AuthEvent) => {
      if (shouldShowSessionExpiredToast(event)) {
        toast.warning(t.common.sessionExpiredReconnect);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [t]);

  return null;
}
