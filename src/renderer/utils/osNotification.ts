// ============================================================================
// 原生系统通知（渲染端出口）
//
// 主进程（webServer sidecar）经 SSE 推 NOTIFICATION_SHOW，由这里在渲染端真正发出：
//   - Tauri 模式：用 @tauri-apps/plugin-notification，原生通知自动带 app（Agent Neo）
//     图标与身份，点击经 onAction 跳到对应会话——替代旧 osascript（无图标、点击不回调）。
//   - Web 模式：回落浏览器 Notification API（best-effort，无权限/headless 时静默）。
// ============================================================================

import { isTauriMode } from './platform';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

type NotifModule = typeof import('@tauri-apps/plugin-notification');

/** 把原生通知投递结果回报主进程（落日志，便于诊断「没弹」）。fire-and-forget。 */
function reportDelivery(report: Record<string, unknown>): void {
  try {
    void ipcService.invokeDomain(IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', report);
  } catch {
    /* ignore */
  }
}

let modulePromise: Promise<NotifModule> | null = null;
function loadModule(): Promise<NotifModule> {
  if (!modulePromise) modulePromise = import('@tauri-apps/plugin-notification');
  return modulePromise;
}

async function ensureTauriPermission(mod: NotifModule): Promise<boolean> {
  let granted = await mod.isPermissionGranted();
  if (!granted) {
    granted = (await mod.requestPermission()) === 'granted';
  }
  return granted;
}

/** 主动请求系统通知授权。用于设置页或测试通知这类明确用户动作，不在 app 启动时预先弹权限。 */
export async function requestOsNotificationPermission(): Promise<boolean> {
  if (!isTauriMode()) return false;
  try {
    const mod = await loadModule();
    return await ensureTauriPermission(mod);
  } catch (err) {
    console.warn('[osNotification] 主动请求通知授权失败', err);
    return false;
  }
}

/**
 * 焦点门控：窗口聚焦且页面可见时，用户正盯着 app，OS 弹窗与应用内反馈（侧栏
 * 未读红点/会话内提示）重复，只打扰不传信 —— 抑制。失焦或页面不可见才放行。
 */
export function shouldSuppressOsNotification(hasFocus: boolean, visible: boolean): boolean {
  return hasFocus && visible;
}

/** 发一条原生系统通知。Tauri 下自动带 Agent Neo 图标/身份；web 回落浏览器通知。 */
export async function postOsNotification(opts: { title: string; body: string }): Promise<void> {
  const hasFocus = typeof document !== 'undefined' && document.hasFocus();
  const visible = typeof document !== 'undefined' && !document.hidden;
  if (shouldSuppressOsNotification(hasFocus, visible)) {
    reportDelivery({ mode: 'suppressed-focused', sent: false });
    return;
  }
  if (isTauriMode()) {
    try {
      const mod = await loadModule();
      const granted = await ensureTauriPermission(mod);
      if (!granted) {
        reportDelivery({ mode: 'tauri', granted: false, sent: false });
        return;
      }
      mod.sendNotification({ title: opts.title, body: opts.body });
      reportDelivery({ mode: 'tauri', granted: true, sent: true });
    } catch (err) {
      console.warn('[osNotification] Tauri sendNotification 失败', err);
      reportDelivery({ mode: 'tauri', error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  reportDelivery({ mode: 'web', perm: typeof Notification !== 'undefined' ? Notification.permission : 'unavailable' });
  // Web 回落：浏览器通知（best-effort）
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission === 'granted') {

      new Notification(opts.title, { body: opts.body });
    }
  } catch {
    /* ignore */
  }
}

/**
 * 注册一次通知点击回调（Tauri onAction）。桌面端点击支持有限，作 best-effort 跳转用；
 * 即便回调不触发，点击通知也会由系统把 app 带到前台。
 */
export async function registerNotificationClick(handler: () => void): Promise<void> {
  if (!isTauriMode()) return;
  try {
    const mod = await loadModule();
    await mod.onAction(() => handler());
  } catch (err) {
    console.warn('[osNotification] onAction 不支持（桌面端常见），点击仅前置 app', err);
  }
}
