import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import type { ManagedBrowserSessionState } from '@shared/contract/desktop';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import ipcService from '../services/ipcService';
import {
  getFrontmostDesktopContext,
  getComputerSurfaceState,
  getNativeDesktopCapabilities,
  getNativeDesktopCollectorStatus,
  getNativeDesktopPermissionStatus,
  isNativeDesktopAvailable,
  listRecentNativeDesktopEvents,
  openNativeDesktopSystemSettings,
  startNativeDesktopCollector,
  type FrontmostContextSnapshot,
  type ComputerSurfaceState,
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
  | 'launch_managed_browser_visible'
  | 'open_screen_capture_settings'
  | 'open_accessibility_settings'
  | 'start_desktop_collector'
  | 'open_desktop_panel';

export interface BrowserWorkbenchRepairAction {
  kind: BrowserWorkbenchRepairActionKind;
  label: string;
}

export interface BrowserWorkbenchReadinessItem {
  key: 'screenCapture' | 'accessibility' | 'browserContext' | 'collector' | 'computerSurface';
  label: string;
  ready: boolean;
  value: string;
  tone?: 'ready' | 'blocked' | 'neutral';
  detail?: string | null;
}

export interface BrowserWorkbenchPreview {
  mode: Exclude<BrowserSessionMode, 'none'>;
  url?: string | null;
  title?: string | null;
  frontmostApp?: string | null;
  lastScreenshotAtMs?: number | null;
  surfaceMode?: string | null;
  traceId?: string | null;
}

export interface BrowserWorkbenchState {
  mode: BrowserSessionMode;
  managedSession: ManagedBrowserSessionState;
  computerSurface: ComputerSurfaceState | null;
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
  if (!status) {
    return '未探测';
  }

  switch (status?.status) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '未授权';
    case 'unsupported':
      return '不支持';
    case 'unknown':
      return '未确认';
    default:
      return '未确认';
  }
}

export function getPermissionReadinessTone(
  status: Pick<NativePermissionStatus, 'status'> | null,
): BrowserWorkbenchReadinessItem['tone'] {
  if (!status || status.status === 'unknown') {
    return 'neutral';
  }
  return status.status === 'granted' ? 'ready' : 'blocked';
}

function getPermissionDetail(
  status: NativePermissionStatus | null,
  label: string,
): string | null {
  if (status?.detail) {
    return status.detail;
  }

  if (!status) {
    return `${label}尚未主动探测；为了避免自动触发系统权限检查，只在点击检查/授权入口后刷新。`;
  }

  if (status.status === 'unknown') {
    return `${label}状态未确认。`;
  }

  if (status.status === 'denied') {
    return `${label}未授权。`;
  }

  if (status.status === 'unsupported') {
    return `${label}在当前平台不支持。`;
  }

  return null;
}

function getPermissionIssue(
  status: NativePermissionStatus | null,
  label: string,
): string | null {
  if (status?.status === 'granted') {
    return null;
  }
  if (status?.status === 'unsupported') {
    return `${label}不支持`;
  }
  if (status?.status === 'denied') {
    return `${label}未授权`;
  }
  return `${label}未确认`;
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
  const [computerSurface, setComputerSurface] = useState<ComputerSurfaceState | null>(null);
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
      setComputerSurface(null);
      return;
    }

    const [capabilitiesResult, collectorResult, frontmostResult, recentEventsResult, computerSurfaceResult] =
      await Promise.allSettled([
        getNativeDesktopCapabilities(),
        getNativeDesktopCollectorStatus(),
        getFrontmostDesktopContext(),
        listRecentNativeDesktopEvents(12),
        getComputerSurfaceState(),
      ]);

    setCapabilities(capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null);
    setCollectorStatus(collectorResult.status === 'fulfilled' ? collectorResult.value : null);
    setFrontmostContext(frontmostResult.status === 'fulfilled' ? frontmostResult.value : null);
    setLastScreenshotAtMs(
      recentEventsResult.status === 'fulfilled'
        ? recentEventsResult.value.find((event) => Boolean(event.screenshotPath))?.capturedAtMs || null
        : null,
    );
    setComputerSurface(computerSurfaceResult.status === 'fulfilled' ? computerSurfaceResult.value : null);
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
    const browserContextKnown = Boolean(capabilities);
    const collectorKnown = Boolean(collectorStatus);
    return [
      {
        key: 'screenCapture',
        label: 'Screen Capture',
        ready: screenCapturePermission?.status === 'granted',
        value: getPermissionLabel(screenCapturePermission),
        tone: getPermissionReadinessTone(screenCapturePermission),
        detail: getPermissionDetail(screenCapturePermission, '屏幕录制'),
      },
      {
        key: 'accessibility',
        label: 'Accessibility',
        ready: accessibilityPermission?.status === 'granted',
        value: getPermissionLabel(accessibilityPermission),
        tone: getPermissionReadinessTone(accessibilityPermission),
        detail: getPermissionDetail(accessibilityPermission, '辅助功能'),
      },
      {
        key: 'browserContext',
        label: 'Browser Context',
        ready: browserContextSupported,
        value: browserContextKnown ? (browserContextSupported ? '支持' : '不支持') : '未知',
        tone: browserContextKnown ? (browserContextSupported ? 'ready' : 'blocked') : 'neutral',
        detail: browserContextSupported
          ? '当前桌面 runtime 可以读取前台浏览器 URL / title。'
          : browserContextKnown
            ? '当前桌面 runtime 不能读取浏览器上下文。'
            : '尚未读到 desktop runtime capabilities。',
      },
      {
        key: 'collector',
        label: 'Collector',
        ready: Boolean(collectorStatus?.running),
        value: collectorKnown ? (collectorStatus?.running ? '采集中' : '已停止') : '未知',
        tone: collectorKnown ? (collectorStatus?.running ? 'ready' : 'blocked') : 'neutral',
        detail: collectorStatus?.lastError || (collectorKnown ? null : 'collector 状态未返回。'),
      },
      {
        key: 'computerSurface',
        label: 'Computer Surface',
        ready: Boolean(computerSurface?.ready),
        value: computerSurface
          ? computerSurface.background
            ? '后台 Accessibility'
            : computerSurface.mode === 'foreground_fallback'
              ? '前台窗口兜底'
              : '不可用'
          : '未知',
        tone: computerSurface
          ? computerSurface.background
            ? 'ready'
            : computerSurface.mode === 'foreground_fallback'
              ? 'neutral'
              : 'blocked'
          : 'neutral',
        detail: computerSurface?.background
          ? (computerSurface.safetyNote || 'Computer Use 会通过 macOS Accessibility 操作指定 app/window。')
          : computerSurface?.mode === 'foreground_fallback'
            ? (computerSurface.safetyNote || 'Computer Use 会作用于当前前台 app/window；没有后台隔离。')
            : 'Computer Surface 状态未返回。',
      },
    ];
  }, [accessibilityPermission, capabilities?.supportsBrowserContext, collectorStatus?.lastError, collectorStatus?.running, computerSurface?.background, computerSurface?.mode, computerSurface?.ready, computerSurface?.safetyNote, mode, screenCapturePermission]);

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
      if (!capabilities) {
        issues.push('desktop capabilities 未返回');
      } else if (!capabilities.supportsBrowserContext) {
        issues.push('browser context 不支持');
      }
      const screenCaptureIssue = getPermissionIssue(screenCapturePermission, '屏幕录制');
      if (screenCaptureIssue) {
        issues.push(screenCaptureIssue);
      }
      const accessibilityIssue = getPermissionIssue(accessibilityPermission, '辅助功能');
      if (accessibilityIssue) {
        issues.push(accessibilityIssue);
      }
      if (!collectorStatus) {
        issues.push('collector 状态未返回');
      } else if (!collectorStatus.running) {
        issues.push('collector 未启动');
      }
    }

    if (issues.length === 0) {
      return null;
    }

    return {
      detail: `当前桌面浏览器上下文未就绪：${issues.join('、')}。`,
      hint: '先确认权限并启动采集；权限未确认时不会后台自动探测，点击检查/授权入口后再刷新。',
    };
  }, [
    accessibilityPermission?.status,
    capabilities?.supportsBrowserContext,
    collectorStatus?.running,
    managedSession.running,
    mode,
    screenCapturePermission?.status,
  ]);

  const repairActions = useMemo<BrowserWorkbenchRepairAction[]>(() => {
    if (mode === 'managed') {
      return managedSession.running
        ? []
        : [
            { kind: 'launch_managed_browser', label: '启动 Headless' },
            { kind: 'launch_managed_browser_visible', label: '启动 Visible' },
          ];
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
        label: screenCaptureStatus === 'denied' ? '授权屏幕录制' : '检查/授权屏幕录制',
      });
    }

    const accessibilityStatus = accessibilityPermission?.status;
    if (accessibilityStatus !== 'granted' && accessibilityStatus !== 'unsupported') {
      actions.push({
        kind: 'open_accessibility_settings',
        label: accessibilityStatus === 'denied' ? '授权辅助功能' : '检查/授权辅助功能',
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
        surfaceMode: managedSession.mode || 'headless',
        traceId: managedSession.lastTrace?.id || null,
      };
    }

    if (mode === 'desktop') {
      return {
        mode,
        url: frontmostContext?.browserUrl || null,
        title: frontmostContext?.browserTitle || frontmostContext?.windowTitle || null,
        frontmostApp: frontmostContext?.appName || null,
        lastScreenshotAtMs,
        surfaceMode: computerSurface?.mode || 'foreground_fallback',
        traceId: computerSurface?.lastAction?.id || null,
      };
    }

    return null;
  }, [
    computerSurface?.lastAction?.id,
    computerSurface?.mode,
    frontmostContext?.appName,
    frontmostContext?.browserTitle,
    frontmostContext?.browserUrl,
    frontmostContext?.windowTitle,
    lastScreenshotAtMs,
    managedSession.activeTab?.title,
    managedSession.activeTab?.url,
    managedSession.lastTrace?.id,
    managedSession.mode,
    mode,
  ]);

  const runRepairAction = useCallback(async (action: BrowserWorkbenchRepairAction) => {
    setBusyActionKind(action.kind);
    setActionError(null);

    try {
      switch (action.kind) {
        case 'launch_managed_browser':
          await ipcService.invokeDomain<ManagedBrowserSessionState>(
            IPC_DOMAINS.DESKTOP,
            'ensureManagedBrowserSession',
            { mode: 'headless' },
          );
          break;
        case 'launch_managed_browser_visible':
          await ipcService.invokeDomain<ManagedBrowserSessionState>(
            IPC_DOMAINS.DESKTOP,
            'ensureManagedBrowserSession',
            { mode: 'visible' },
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
    computerSurface,
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
