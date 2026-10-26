import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

/** verify-shot 只能打开 URL。返回 true 表示这次查询真的摊开了一页。 */
function applyLedgerDeepLink(params: URLSearchParams): boolean {
  const open = params.get('open');
  if (open === 'automation') {
    useAppStore.getState().setShowCronCenter(true);
    return true;
  }
  if (open === 'role') {
    const roleId = params.get('roleId');
    if (!roleId) return false;
    useAppStore.getState().openExpertRoleDetail(roleId);
    return true;
  }
  return false;
}

/**
 * `?open=automation|role` 把运行账本页直接摊开。
 * 冷启动 `initializeSessionStore` → `switchSession` 会 `closeSecondaryPages()`，
 * 并且发生在这次打开之后。会话 id 第一次变化时再摊开一次；
 * 之后用户关掉或再切会话，不再钉住。
 */
export function useLedgerDeepLink(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!applyLedgerDeepLink(params)) return;
    let reapplied = false;
    return useSessionStore.subscribe((state, previous) => {
      if (reapplied || state.currentSessionId === previous.currentSessionId) return;
      reapplied = true;
      applyLedgerDeepLink(params);
    });
  }, []);
}
