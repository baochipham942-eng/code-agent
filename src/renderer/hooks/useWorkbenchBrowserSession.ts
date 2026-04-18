import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import type { ManagedBrowserSessionState } from '@shared/contract/desktop';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import ipcService from '../services/ipcService';
import {
  getFrontmostDesktopContext,
  getNativeDesktopCapabilities,
  getNativeDesktopCollectorStatus,
  getNativeDesktopPermissionStatus,
  isNativeDesktopAvailable,
  listRecentNativeDesktopEvents,
  openNativeDesktopSystemSettings,
  startNativeDesktopCollector,
  type FrontmostContextSnapshot,
  type NativeDesktopCapabilities,
  type NativeDesktopCollectorStatus,
  type NativePermissionSnapshot,
  type NativePermissionStatus,
} from '../services/nativeDesktop';

const EMPTY_MANAGED_BROWSER_SESSION: ManagedBrowserSessionState = {
  running: false,
  tabCount: 0,
  activeTab: null,
};

type BrowserWorkbenchRepairActionKind =
  | 'launch_managed_browser'
  | 'open_screen_capture_settings'
  | 'open_accessibility_settings'
  | 'start_desktop_collector'
  | 'open_desktop_panel';

export interface BrowserWorkbenchRepairAction {
  kind: BrowserWorkbenchRepairActionKind;
  label: string;
}

export interface BrowserWorkbenchReadinessItem {
  key: 'screenCapture' | 'accessibility' | 'browserContext' | 'collector';
  label: string;
  ready: boolean;
  value: string;
  detail?: string | null;
}

export interface BrowserWorkbenchPreview {
  mode: Exclude<BrowserSessionMode, 'none'>;
  url?: string | null;
  title?: string | null;
  frontmostApp?: string | null;
  lastScreenshotAtMs?: number | null;
}

export interface BrowserWorkbenchState {
  mode: BrowserSessionMode;
  managedSession: ManagedBrowserSessionState;
  preview: BrowserWorkbenchPreview | null;
  readinessItems: BrowserWorkbenchReadinessItem[];
  blocked: boolean;
  blockedDetail?: string;
  blockedHint?: string;
  repairActions: BrowserWorkbenchRepairAction[];
  busyActionKind: BrowserWorkbenchRepairActionKind | null;
  actionError: string | null;
}

function getPermissionStatus(
  snapshot: NativePermissionSnapshot | null,
  kind: string,
): NativePermissionStatus | null {
  return snapshot?.permissions.find((permission) => permission.kind === kind) || null;
}

function getPermissionLabel(status: NativePermissionStatus | null): string {
  switch (status?.status) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '未授权';
    case 'unsupported':
      return '不支持';
    case 'unknown':
      return '未知';
    default:
      return '未知';
  }
}

async function loadManagedBrowserSession(): Promise<ManagedBrowserSessionState> {
  try {
    return await ipcService.invokeDomain<ManagedBrowserSessionState>(
      IPC_DOMAINS.DESKTOP,
      'getManagedBrowserSession',
    );
  } catch {
    return EMPTY_MANAGED_BROWSER_SESSION;
  }
}

export function useWorkbenchBrowserSession(): BrowserWorkbenchState & {
  refresh: () => Promise<void>;
  probePermissions: () => Promise<void>;
  runRepairAction: (action: BrowserWorkbenchRepairAction) => Promise<void>;
} {
  const mode = useComposerStore((state) => state.browserSessionMode);
  const setShowDesktopPanel = useAppStore((state) => state.setShowDesktopPanel);
  const [managedSession, setManagedSession] = useState<ManagedBrowserSessionState>(EMPTY_MANAGED_BROWSER_SESSION);
  const [capabilities, setCapabilities] = useState<NativeDesktopCapabilities | null>(null);
  const [permissionSnapshot, setPermissionSnapshot] = useState<NativePermissionSnapshot | null>(null);
  const [collectorStatus, setCollectorStatus] = useState<NativeDesktopCollectorStatus | null>(null);
  const [frontmostContext, setFrontmostContext] = useState<FrontmostContextSnapshot | null>(null);
  const [lastScreenshotAtMs, setLastScreenshotAtMs] = useState<number | null>(null);
  const [busyActionKind, setBusyActionKind] = useState<BrowserWorkbenchRepairActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // refresh 不再触达 OS 权限 API —— CGPreflightScreenCaptureAccess 和
  // AXIsProcessTrusted 是同步阻塞 FFI，会记入 macOS 访问日志并可能卡死主线程。
  // 权限探测改为 probePermissions()，只在用户显式点击"授权"类按钮时才调。
  const refresh = useCallback(async () => {
    setManagedSession(await loadManagedBrowserSession());

    if (!isNativeDesktopAvailable()) {
      setCapabilities(null);
      setCollectorStatus(null);
      setFrontmostContext(null);
      setLastScreenshotAtMs(null);
      return;
    }

    const [capabilitiesResult, collectorResult, frontmostResult, recentEventsResult] =
      await Promise.allSettled([
        getNativeDesktopCapabilities(),
        getNativeDesktopCollectorStatus(),
        getFrontmostDesktopContext(),
        listRecentNativeDesktopEvents(12),
      ]);

    setCapabilities(capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null);
    setCollectorStatus(collectorResult.status === 'fulfilled' ? collectorResult.value : null);
    setFrontmostContext(frontmostResult.status === 'fulfilled' ? frontmostResult.value : null);
    setLastScreenshotAtMs(
      recentEventsResult.status === 'fulfilled'
        ? recentEventsResult.value.find((event) => Boolean(event.screenshotPath))?.capturedAtMs || null
        : null,
    );
  }, []);

  // Lazy 权限探测 —— 仅在修复动作（open_screen_capture_settings /
  // open_accessibility_settings）前调，或在用户显式请求时调。
  const probePermissions = useCallback(async () => {
    if (!isNativeDesktopAvailable()) {
      setPermissionSnapshot(null);
      return;
    }
    try {
      setPermissionSnapshot(await getNativeDesktopPermissionStatus());
    } catch {
      setPermissionSnapshot(null);
    }
  }, []);

  // Mount：只 probe 托管浏览器状态（无 OS 权限调用）
  useEffect(() => {
    void (async () => {
      setManagedSession(await loadManagedBrowserSession());
    })();
  }, []);

  // 用户显式进入 browser workbench 后做一次 refresh（仍不触达 OS 权限 API）
  useEffect(() => {
    if (mode !== 'none') {
      void refresh();
    }
  }, [mode, refresh]);

  useEffect(() => {
    if (mode === 'none' && !managedSession.running && !collectorStatus?.running) {
      return;
    }

    const timer = window.setInterval(() => {
      void refresh();
    }, 5_000);

    return () => window.clearInterval(timer);
  }, [collectorStatus?.running, managedSession.running, mode, refresh]);

  const screenCapturePermission = useMemo(
    () => getPermissionStatus(permissionSnapshot, 'screenCapture'),
    [permissionSnapshot],
  );
  const accessibilityPermission = useMemo(
    () => getPermissionStatus(permissionSnapshot, 'accessibility'),
    [permissionSnapshot],
  );

  const readinessItems = useMemo<BrowserWorkbenchReadinessItem[]>(() => {
    if (mode !== 'desktop') {
      return [];
    }

    const browserContextSupported = Boolean(capabilities?.supportsBrowserContext);
    return [
      {
        key: 'screenCapture',
        label: 'Screen Capture',
        ready: screenCapturePermission?.status === 'granted',
        value: getPermissionLabel(screenCapturePermission),
        detail: screenCapturePermission?.detail || null,
      },
      {
        key: 'accessibility',
        label: 'Accessibility',
        ready: accessibilityPermission?.status === 'granted',
        value: getPermissionLabel(accessibilityPermission),
        detail: accessibilityPermission?.detail || null,
      },
      {
        key: 'browserContext',
        label: 'Browser Context',
        ready: browserContextSupported,
        value: browserContextSupported ? '支持' : '不支持',
        detail: browserContextSupported
          ? '当前桌面 runtime 可以读取前台浏览器 URL / title。'
          : '当前桌面 runtime 不能读取浏览器上下文。',
      },
      {
        key: 'collector',
        label: 'Collector',
        ready: Boolean(collectorStatus?.running),
        value: collectorStatus?.running ? '采集中' : '已停止',
        detail: collectorStatus?.lastError || null,
      },
    ];
  }, [accessibilityPermission, capabilities?.supportsBrowserContext, collectorStatus?.lastError, collectorStatus?.running, mode, screenCapturePermission]);

  const blockedState = useMemo(() => {
    if (mode === 'managed') {
      if (managedSession.running) {
        return null;
      }
      return {
        detail: '托管浏览器还没启动，本轮如果走 browser_action / computer_use 的智能浏览器路径会直接失败。',
        hint: '先启动托管浏览器；如果你是想借当前桌面上的浏览器标签页，改选 Desktop。',
      };
    }

    if (mode !== 'desktop') {
      return null;
    }

    const issues: string[] = [];
    if (!isNativeDesktopAvailable()) {
      issues.push('当前不是桌面 runtime');
    } else {
      if (!capabilities?.supportsBrowserContext) {
        issues.push('browser context 不支持');
      }
      if (screenCapturePermission?.status !== 'granted') {
        issues.push('屏幕录制未授权');
      }
      if (accessibilityPermission?.status !== 'granted') {
        issues.push('辅助功能未授权');
      }
      if (!collectorStatus?.running) {
        issues.push('collector 未启动');
      }
    }

    if (issues.length === 0) {
      return null;
    }

    return {
      detail: `当前桌面浏览器上下文未就绪：${issues.join('、')}。`,
      hint: '先补权限并启动采集；修好后这条消息再发出去，会比黑箱失败可控得多。',
    };
  }, [accessibilityPermission?.status, capabilities?.supportsBrowserContext, collectorStatus?.running, mode, screenCapturePermission?.status]);

  const repairActions = useMemo<BrowserWorkbenchRepairAction[]>(() => {
    if (mode === 'managed') {
      return managedSession.running
        ? []
        : [{ kind: 'launch_managed_browser', label: '启动托管浏览器' }];
    }

    if (mode !== 'desktop') {
      return [];
    }

    const actions: BrowserWorkbenchRepairAction[] = [];

    // 当 permission snapshot 未 probe 过（null）或显示 denied/unknown 时都给出授权入口。
    // 仅 'granted' 和 'unsupported' 时不显示 —— 避免在 granted 后仍出按钮，也避免
    // 在非 macOS 平台误展示。
    const screenCaptureStatus = screenCapturePermission?.status;
    if (screenCaptureStatus !== 'granted' && screenCaptureStatus !== 'unsupported') {
      actions.push({
        kind: 'open_screen_capture_settings',
        label: '授权屏幕录制',
      });
    }

    const accessibilityStatus = accessibilityPermission?.status;
    if (accessibilityStatus !== 'granted' && accessibilityStatus !== 'unsupported') {
      actions.push({
        kind: 'open_accessibility_settings',
        label: '授权辅助功能',
      });
    }

    if (isNativeDesktopAvailable() && !collectorStatus?.running) {
      actions.push({
        kind: 'start_desktop_collector',
        label: '启动采集',
      });
    }

    actions.push({
      kind: 'open_desktop_panel',
      label: '打开桌面面板',
    });

    return actions;
  }, [accessibilityPermission?.status, collectorStatus?.running, mode, screenCapturePermission?.status]);

  const preview = useMemo<BrowserWorkbenchPreview | null>(() => {
    if (mode === 'managed') {
      return {
        mode,
        url: managedSession.activeTab?.url || null,
        title: managedSession.activeTab?.title || null,
      };
    }

    if (mode === 'desktop') {
      return {
        mode,
        url: frontmostContext?.browserUrl || null,
        title: frontmostContext?.browserTitle || frontmostContext?.windowTitle || null,
        frontmostApp: frontmostContext?.appName || null,
        lastScreenshotAtMs,
      };
    }

    return null;
  }, [frontmostContext?.appName, frontmostContext?.browserTitle, frontmostContext?.browserUrl, frontmostContext?.windowTitle, lastScreenshotAtMs, managedSession.activeTab?.title, managedSession.activeTab?.url, mode]);

  const runRepairAction = useCallback(async (action: BrowserWorkbenchRepairAction) => {
    setBusyActionKind(action.kind);
    setActionError(null);

    try {
      switch (action.kind) {
        case 'launch_managed_browser':
          await ipcService.invokeDomain<ManagedBrowserSessionState>(
            IPC_DOMAINS.DESKTOP,
            'ensureManagedBrowserSession',
          );
          break;
        case 'open_screen_capture_settings':
          await openNativeDesktopSystemSettings('screenCapture');
          await probePermissions();
          break;
        case 'open_accessibility_settings':
          await openNativeDesktopSystemSettings('accessibility');
          await probePermissions();
          break;
        case 'start_desktop_collector':
          await startNativeDesktopCollector({
            intervalSecs: 30,
            captureScreenshots: true,
            redactSensitiveContexts: true,
            retentionDays: 7,
            dedupeWindowSecs: 60,
            maxRecentEvents: 50,
          });
          break;
        case 'open_desktop_panel':
          setShowDesktopPanel(true);
          break;
        default:
          break;
      }

      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusyActionKind(null);
    }
  }, [probePermissions, refresh, setShowDesktopPanel]);

  return {
    mode,
    managedSession,
    preview,
    readinessItems,
    blocked: Boolean(blockedState),
    blockedDetail: blockedState?.detail,
    blockedHint: blockedState?.hint,
    repairActions,
    busyActionKind,
    actionError,
    refresh,
    probePermissions,
    runRepairAction,
  };
}
