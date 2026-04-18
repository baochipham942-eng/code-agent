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

  const refresh = useCallback(async () => {
    setManagedSession(await loadManagedBrowserSession());

    if (!isNativeDesktopAvailable()) {
      setCapabilities(null);
      setPermissionSnapshot(null);
      setCollectorStatus(null);
      setFrontmostContext(null);
      setLastScreenshotAtMs(null);
      return;
    }

    const [capabilitiesResult, permissionResult, collectorResult, frontmostResult, recentEventsResult] =
      await Promise.allSettled([
        getNativeDesktopCapabilities(),
        getNativeDesktopPermissionStatus(),
        getNativeDesktopCollectorStatus(),
        getFrontmostDesktopContext(),
        listRecentNativeDesktopEvents(12),
      ]);

    setCapabilities(capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null);
    setPermissionSnapshot(permissionResult.status === 'fulfilled' ? permissionResult.value : null);
    setCollectorStatus(collectorResult.status === 'fulfilled' ? collectorResult.value : null);
    setFrontmostContext(frontmostResult.status === 'fulfilled' ? frontmostResult.value : null);
    setLastScreenshotAtMs(
      recentEventsResult.status === 'fulfilled'
        ? recentEventsResult.value.find((event) => Boolean(event.screenshotPath))?.capturedAtMs || null
        : null,
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

    if (screenCapturePermission?.status === 'denied') {
      actions.push({
        kind: 'open_screen_capture_settings',
        label: '授权屏幕录制',
      });
    }

    if (accessibilityPermission?.status === 'denied') {
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
          break;
        case 'open_accessibility_settings':
          await openNativeDesktopSystemSettings('accessibility');
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
  }, [refresh, setShowDesktopPanel]);

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
    runRepairAction,
  };
}
