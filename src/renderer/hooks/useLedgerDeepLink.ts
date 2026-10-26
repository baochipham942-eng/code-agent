import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

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

/** 冷启动会连切两次会话（初始化 + 登录重载）。同 id 的第二次只关页、不改 id。 */
const STARTUP_REAPPLY_WINDOW_MS = 8_000;

/**
 * `?open=automation|role` 把运行账本页直接摊开。
 * `switchSession` 在早退之前就 `closeSecondaryPages()`，所以同一次 id 上的
 * 第二次切换不会让会话订阅看到变化。启动窗口内页被关掉就再摊开；窗口过后不再钉住。
 */
export function useLedgerDeepLink(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!applyLedgerDeepLink(params)) return;
    const open = params.get('open');
    const roleId = params.get('roleId');
    const deadline = Date.now() + STARTUP_REAPPLY_WINDOW_MS;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (Date.now() > deadline) return;
      const closedAutomation = open === 'automation'
        && previous.showCronCenter
        && !state.showCronCenter;
      const closedRole = open === 'role'
        && roleId != null
        && previous.expertDetailRoleId === roleId
        && state.expertDetailRoleId !== roleId;
      if (closedAutomation || closedRole) applyLedgerDeepLink(params);
    });
    const timer = window.setTimeout(unsubscribe, STARTUP_REAPPLY_WINDOW_MS);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);
}
