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
import { getNativeDesktopPermissionStatus, isNativeDesktopAvailable } from '../services/nativeDesktop';
import { toast } from '../hooks/useToast';
import { OS_NOTIFICATION_TIMEOUTS } from '@shared/constants';

const FOREGROUND_FAILURE_TOAST_MS = 10_000;

type NotifModule = typeof import('@tauri-apps/plugin-notification');
type OsNotificationPermission = 'granted' | 'denied' | 'unknown';
type OsNotificationPermissionSnapshot = {
  permission: OsNotificationPermission;
  platform: string | null;
  permissionReadTimedOut?: true;
};

export async function getOsNotificationPermissionSnapshot(): Promise<OsNotificationPermissionSnapshot> {
  if (!isNativeDesktopAvailable()) return { permission: 'unknown', platform: null };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), OS_NOTIFICATION_TIMEOUTS.PERMISSION_READ_MS);
    });
    const raced = await Promise.race([getNativeDesktopPermissionStatus(), timeout]).finally(() => clearTimeout(timer));
    if (raced === 'timeout') {
      console.warn('[osNotification] 读取系统通知权限超时，按 unknown 继续发送');
      return { permission: 'unknown', platform: null, permissionReadTimedOut: true };
    }
    const snapshot = raced;
    const status = snapshot.permissions.find((permission) => permission.kind === 'notifications')?.status;
    return {
      permission: status === 'granted' || status === 'denied' ? status : 'unknown',
      platform: snapshot.platform,
    };
  } catch {
    return { permission: 'unknown', platform: null };
  }
}

export async function getOsNotificationPermission(): Promise<OsNotificationPermission> {
  return (await getOsNotificationPermissionSnapshot()).permission;
}

/** 把原生通知投递结果回报主进程（落日志，便于诊断「没弹」）。fire-and-forget。 */
/** 供 hook 在未走 postOsNotification 的早退分支里留痕。 */
export function reportNotificationHandled(report: Record<string, unknown>): void {
  reportDelivery(report);
}

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

/**
 * 焦点门控：窗口聚焦且页面可见时，用户正盯着 app，OS 弹窗与应用内反馈（侧栏
 * 未读红点/会话内提示）重复，只打扰不传信 —— 抑制。失焦或页面不可见才放行。
 */
export function shouldSuppressOsNotification(hasFocus: boolean, visible: boolean): boolean {
  return hasFocus && visible;
}

/** 发一条原生系统通知。Tauri 下自动带 Agent Neo 图标/身份；web 回落浏览器通知。 */
export async function postOsNotification(
  opts: { title: string; body: string },
  flags: PostFlags = {},
): Promise<void> {
  // 每次调用恰好一条回报：任何抛错都兜底成一条带 error 的回报。
  let reported = false;
  const report = (r: Record<string, unknown>): void => {
    reported = true;
    reportDelivery(r);
  };
  try {
    await postOsNotificationInner(opts, flags, report);
  } catch (err) {
    console.warn('[osNotification] postOsNotification 异常', err);
    if (!reported) {
      report({ mode: isTauriMode() ? 'tauri' : 'web', error: err instanceof Error ? err.message : String(err) });
    }
  }
}

type PostFlags = { urgent?: boolean; failure?: boolean; viewingSession?: boolean; onOpen?: () => void; openLabel?: string };

async function postOsNotificationInner(
  opts: { title: string; body: string },
  flags: PostFlags,
  reportDelivery: (r: Record<string, unknown>) => void,
): Promise<void> {
  const urgent = flags.urgent === true;
  const hasFocus = typeof document !== 'undefined' && document.hasFocus();
  const visible = typeof document !== 'undefined' && !document.hidden;
  // urgent 跳过普通焦点门：失败、等输入都不能因为 app 聚焦而错过。
  if (!urgent && shouldSuppressOsNotification(hasFocus, visible)) {
    reportDelivery({ mode: 'suppressed-focused', dispatched: false });
    return;
  }
  // needs-input（urgent 且非失败）例外：用户正聚焦看着需要输入的那个会话时，
  // 审批/提问卡片就在屏幕上，横幅只是重复打扰；看别的会话、失焦、隐藏仍弹。
  if (urgent && flags.failure !== true && flags.viewingSession === true && shouldSuppressOsNotification(hasFocus, visible)) {
    reportDelivery({ mode: 'suppressed-viewing', dispatched: false });
    return;
  }
  // macOS 在 app 为 key window 时会藏起原生横幅：urgent 失败在前台补一条应用内 toast。
  // 仅失败：needs-input 同为 urgent，但不是失败，不能弹红色错误 toast。
  const toastShown = urgent && flags.failure === true && hasFocus && visible;
  if (toastShown) {
    const { onOpen, openLabel } = flags;
    toast.error(
      `${opts.title}: ${opts.body}`,
      onOpen && openLabel ? { label: openLabel, onClick: onOpen } : undefined,
      FOREGROUND_FAILURE_TOAST_MS,
    );
  }
  const toastFlag = toastShown ? { toastShown: true } : {};
  if (isTauriMode()) {
    try {
      const { permission, permissionReadTimedOut } = await getOsNotificationPermissionSnapshot();
      const timeoutFlag = permissionReadTimedOut ? { permissionReadTimedOut: true } : {};
      if (permission === 'denied') {
        reportDelivery({ mode: 'tauri', granted: false, dispatched: false, ...(urgent ? { urgent } : {}), ...toastFlag });
        return;
      }
      const mod = await loadModule();
      // dispatched = OS API accepted the call; macOS gives no callback, so display is not confirmed.
      mod.sendNotification({ title: opts.title, body: opts.body });
      reportDelivery({
        mode: 'tauri',
        ...(permission === 'granted' ? { granted: true } : { permission: 'unknown' }),
        dispatched: true,
        ...timeoutFlag,
        ...(urgent ? { urgent } : {}),
        ...toastFlag,
      });
    } catch (err) {
      console.warn('[osNotification] Tauri sendNotification 失败', err);
      reportDelivery({ mode: 'tauri', error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  reportDelivery({
    mode: 'web',
    perm: typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
    ...(urgent ? { urgent } : {}),
    ...toastFlag,
  });
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
export async function registerNotificationClick(
  handler: () => void,
): Promise<(() => Promise<void>) | undefined> {
  if (!isTauriMode()) return undefined;
  try {
    const mod = await loadModule();
    const listener = await mod.onAction(() => handler());
    // Tauri returns a PluginListener so callers can release the native callback
    // when the owning React effect unmounts.
    return () => listener.unregister();
  } catch (err) {
    console.warn('[osNotification] onAction 不支持（桌面端常见），点击仅前置 app', err);
    return undefined;
  }
}
