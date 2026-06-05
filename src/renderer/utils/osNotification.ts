// ============================================================================
// 原生系统通知（渲染端出口）
//
// 主进程（webServer sidecar）经 SSE 推 NOTIFICATION_SHOW，由这里在渲染端真正发出：
//   - Tauri 模式：用 @tauri-apps/plugin-notification，原生通知自动带 app（Agent Neo）
//     图标与身份，点击经 onAction 跳到对应会话——替代旧 osascript（无图标、点击不回调）。
//   - Web 模式：回落浏览器 Notification API（best-effort，无权限/headless 时静默）。
// ============================================================================

import { isTauriMode } from './platform';

type NotifModule = typeof import('@tauri-apps/plugin-notification');

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

/** 发一条原生系统通知。Tauri 下自动带 Agent Neo 图标/身份；web 回落浏览器通知。 */
export async function postOsNotification(opts: { title: string; body: string }): Promise<void> {
  if (isTauriMode()) {
    try {
      const mod = await loadModule();
      if (!(await ensureTauriPermission(mod))) return;
      mod.sendNotification({ title: opts.title, body: opts.body });
    } catch (err) {
      console.warn('[osNotification] Tauri sendNotification 失败', err);
    }
    return;
  }
  // Web 回落：浏览器通知（best-effort）
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission === 'granted') {
      // eslint-disable-next-line no-new
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
