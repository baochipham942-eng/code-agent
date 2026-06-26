import type { ToolCall } from '@shared/contract';
import type {
  ComputerSurfaceState,
  DesktopActivityEvent,
  FrontmostContextSnapshot,
  NativeDesktopCapabilities,
  NativePermissionSnapshot,
  NativePermissionStatus,
  WorkbenchActionTrace,
} from '../services/nativeDesktop';
import {
  buildBrowserComputerActionPreview,
  summarizeBrowserComputerActionResult,
  type BrowserComputerActionPreview,
} from './browserComputerActionPreview';

export type ComputerUseTargetSource = 'frontmost' | 'surface' | 'recent' | 'approved' | 'denied';

export interface ComputerUseTarget {
  id: string;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  capturedAtMs?: number | null;
  source: ComputerUseTargetSource;
  state?: 'approved' | 'denied' | null;
}

export interface ComputerUseActionTraceSummary {
  trace: WorkbenchActionTrace;
  preview: BrowserComputerActionPreview | null;
  resultSummary: string | null;
}

export interface ComputerUseFailureExplanation {
  id: string;
  title: string;
  detail: string;
  tone: 'blocked' | 'warning' | 'neutral';
}

export interface ComputerUseFailureInput {
  nativeAvailable: boolean;
  desktopProviderError?: string | null;
  capabilities?: NativeDesktopCapabilities | null;
  permissions?: NativePermissionSnapshot | null;
  surface?: ComputerSurfaceState | null;
  targets: ComputerUseTarget[];
  selectedTargetApp?: string | null;
  elementsError?: string | null;
  observeError?: string | null;
  /** cua 走 capture_mode=ax 时置 true：把 Screen Recording 降为可选，不再当作阻断项。 */
  screenCaptureOptional?: boolean;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function makeTargetId(source: ComputerUseTargetSource, appName: string, windowTitle?: string | null): string {
  return [source, appName, windowTitle || ''].join(':');
}

function pushUniqueTarget(
  targets: ComputerUseTarget[],
  seen: Set<string>,
  target: Omit<ComputerUseTarget, 'id'>,
): void {
  const appName = target.appName.trim();
  if (!appName) {
    return;
  }
  const key = `${appName.toLowerCase()}::${target.windowTitle?.trim().toLowerCase() || ''}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  targets.push({
    ...target,
    appName,
    id: makeTargetId(target.source, appName, target.windowTitle),
  });
}

export function buildComputerUseTargets(input: {
  frontmost?: FrontmostContextSnapshot | null;
  recentEvents?: DesktopActivityEvent[];
  surface?: ComputerSurfaceState | null;
}): ComputerUseTarget[] {
  const targets: ComputerUseTarget[] = [];
  const seen = new Set<string>();

  const frontmostApp = asNonEmptyString(input.frontmost?.appName);
  if (frontmostApp) {
    pushUniqueTarget(targets, seen, {
      source: 'frontmost',
      appName: frontmostApp,
      bundleId: input.frontmost?.bundleId || null,
      windowTitle: input.frontmost?.windowTitle || input.frontmost?.browserTitle || null,
      capturedAtMs: input.frontmost?.capturedAtMs || null,
    });
  }

  const surfaceTarget = asNonEmptyString(input.surface?.targetApp);
  if (surfaceTarget) {
    pushUniqueTarget(targets, seen, {
      source: 'surface',
      appName: surfaceTarget,
      windowTitle: input.surface?.lastSnapshot?.windowTitle || null,
      capturedAtMs: input.surface?.lastSnapshot?.capturedAtMs || null,
    });
  }

  const snapshotApp = asNonEmptyString(input.surface?.lastSnapshot?.appName);
  if (snapshotApp) {
    pushUniqueTarget(targets, seen, {
      source: 'surface',
      appName: snapshotApp,
      windowTitle: input.surface?.lastSnapshot?.windowTitle || null,
      capturedAtMs: input.surface?.lastSnapshot?.capturedAtMs || null,
    });
  }

  for (const appName of input.surface?.approvedApps || []) {
    if (asNonEmptyString(appName)) {
      pushUniqueTarget(targets, seen, {
        source: 'approved',
        appName,
        state: 'approved',
      });
    }
  }

  for (const appName of input.surface?.deniedApps || []) {
    if (asNonEmptyString(appName)) {
      pushUniqueTarget(targets, seen, {
        source: 'denied',
        appName,
        state: 'denied',
      });
    }
  }

  const recent = [...(input.recentEvents || [])]
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs)
    .slice(0, 24);
  for (const event of recent) {
    const appName = asNonEmptyString(event.appName);
    if (!appName) {
      continue;
    }
    pushUniqueTarget(targets, seen, {
      source: 'recent',
      appName,
      bundleId: event.bundleId || null,
      windowTitle: event.windowTitle || event.browserTitle || null,
      capturedAtMs: event.capturedAtMs,
    });
    if (targets.length >= 12) {
      break;
    }
  }

  return targets;
}

export function getNativePermissionStatus(
  snapshot: NativePermissionSnapshot | null | undefined,
  kind: string,
): NativePermissionStatus | null {
  return snapshot?.permissions.find((permission) => permission.kind === kind) || null;
}

function getPermissionCopy(kind: string): string {
  if (kind === 'screenCapture') return 'Screen Recording';
  if (kind === 'accessibility') return 'Accessibility';
  return kind;
}

function addExplanation(
  items: ComputerUseFailureExplanation[],
  item: ComputerUseFailureExplanation,
): void {
  if (!items.some((existing) => existing.id === item.id)) {
    items.push(item);
  }
}

function explainPermission(
  items: ComputerUseFailureExplanation[],
  permission: NativePermissionStatus | null,
  kind: 'screenCapture' | 'accessibility',
  optional = false,
): void {
  const label = getPermissionCopy(kind);
  // cua 默认 capture_mode=ax（只读 AX 树，免录屏）。录屏是可选增强：未授权不阻断，
  // 仅提示「需要视觉消歧时再开」。详见 内部文档 §11.1。
  if (optional && (permission?.status !== 'granted')) {
    addExplanation(items, {
      id: `${kind}:optional`,
      title: `${label} 可选`,
      detail: '默认走 AX 树模式（capture_mode=ax），无需录屏权限。仅当需要截图做视觉消歧时再单独授权。',
      tone: 'neutral',
    });
    return;
  }
  if (!permission) {
    addExplanation(items, {
      id: `${kind}:unknown`,
      title: `${label} 未探测`,
      detail: '当前页还没有拿到 macOS TCC 状态，Computer Use 只能展示降级原因，不能判断截图或 AX 读取是否可靠。',
      tone: 'warning',
    });
    return;
  }

  if (permission.status === 'granted') {
    return;
  }

  if (permission.status === 'unsupported') {
    addExplanation(items, {
      id: `${kind}:unsupported`,
      title: `${label} 当前平台不支持`,
      detail: permission.detail || '这个权限只在 macOS 桌面 runtime 下可用。',
      tone: 'neutral',
    });
    return;
  }

  if (permission.status === 'needs_restart') {
    addExplanation(items, {
      id: `${kind}:needs_restart`,
      title: `${label} 需要重启`,
      detail: permission.detail || `${label} 授权后需要重启 Agent Neo 才能生效。`,
      tone: 'blocked',
    });
    return;
  }

  if (permission.status === 'wrong_bundle_id') {
    addExplanation(items, {
      id: `${kind}:wrong_bundle_id`,
      title: `${label} Bundle 不匹配`,
      detail: permission.detail || `${label} 授权落在了另一个包上，请给当前运行包重新授权。`,
      tone: 'blocked',
    });
    return;
  }

  addExplanation(items, {
    id: `${kind}:${permission.status}`,
    title: `${label} ${permission.status === 'denied' ? '未授权' : '未确认'}`,
    detail: permission.detail || `${label} 状态未确认，窗口截图、AX tree 或浏览器上下文读取可能失败。`,
    tone: permission.status === 'denied' ? 'blocked' : 'warning',
  });
}

function explainFailureKind(kind: string): Omit<ComputerUseFailureExplanation, 'id'> {
  switch (kind) {
    case 'permission_denied':
      return {
        title: '权限未开',
        detail: 'macOS 拒绝了 Computer Surface 读取或控制。通常要检查 Accessibility 和 Screen Recording。',
        tone: 'blocked',
      };
    case 'target_app_not_running':
      return {
        title: '目标 app 没运行',
        detail: '目标 app 不在当前可见进程或最近窗口候选里，先让目标 app 启动并出现窗口。',
        tone: 'blocked',
      };
    case 'target_not_frontmost':
      return {
        title: '目标不在前台',
        detail: '当前 surface 需要前台窗口兜底，目标 app 没有前台焦点时不该执行坐标或键盘动作。',
        tone: 'warning',
      };
    case 'target_window_not_found':
      return {
        title: '窗口不可读',
        detail: '窗口 id、标题或 bounds 已失效，重新读取窗口候选后再判断能不能后台操作。',
        tone: 'blocked',
      };
    case 'ax_unavailable':
      return {
        title: 'AX tree 不可用',
        detail: '目标 app 没有暴露可用 Accessibility tree，或当前权限不足。Electron、CEF、WKWebView 壳常见只暴露很浅的容器。',
        tone: 'blocked',
      };
    case 'ax_tree_poor':
      return {
        title: 'AX tree 质量低',
        detail: '元素缺少 label、role 或 axPath，自动定位容易误命中。Electron、CEF、WKWebView 壳也常见这种浅层 tree；先展示候选和失败原因，避免直接执行。',
        tone: 'warning',
      };
    case 'locator_missing':
      return {
        title: '目标元素找不到',
        detail: '当前 selector、role/name 或 axPath 没命中。需要重新读取 AX candidates 或前台观察。',
        tone: 'warning',
      };
    case 'locator_ambiguous':
      return {
        title: '目标元素不唯一',
        detail: '多个元素同时匹配，应该选择具体 axPath 或更窄的 role/name。',
        tone: 'warning',
      };
    case 'coordinate_untrusted':
      return {
        title: '坐标不可信',
        detail: '窗口坐标和当前屏幕证据对不上，不能把坐标动作当成可靠后台控制。',
        tone: 'blocked',
      };
    case 'action_execution_failed':
      return {
        title: '动作执行失败',
        detail: '底层系统事件或 AX 调用失败。当前页只展示失败证据，不自动重试。',
        tone: 'blocked',
      };
    default:
      return {
        title: '证据不可用',
        detail: '没有足够的窗口、截图或 AX 证据支撑 Computer Use 动作。',
        tone: 'warning',
      };
  }
}

export function buildRecentComputerUseAction(
  surface: ComputerSurfaceState | null | undefined,
): ComputerUseActionTraceSummary | null {
  const trace = surface?.lastAction;
  if (!trace) {
    return null;
  }

  const mode = trace.mode || surface?.mode || 'foreground_fallback';
  const metadata: Record<string, unknown> = {
    computerSurfaceMode: mode,
    workbenchTrace: {
      id: trace.id,
      mode,
    },
    targetApp: surface?.targetApp || undefined,
    failureKind: trace.failureKind || undefined,
    blockingReasons: trace.blockingReasons,
    recommendedAction: trace.recommendedAction || undefined,
    axQuality: trace.axQuality || undefined,
  };
  if (mode === 'background_ax') {
    metadata.backgroundSurface = true;
  }
  if (mode === 'foreground_fallback') {
    metadata.foregroundFallback = true;
  }

  const toolCall: ToolCall = {
    id: trace.id,
    name: 'computer_use',
    arguments: {
      action: trace.action || 'get_state',
      targetApp: surface?.targetApp || undefined,
    },
    result: {
      toolCallId: trace.id,
      success: !trace.failureKind,
      error: trace.failureKind || undefined,
      output: trace.evidenceSummary?.join('\n') || '',
      metadata,
    },
  };

  return {
    trace,
    preview: buildBrowserComputerActionPreview(toolCall),
    resultSummary: summarizeBrowserComputerActionResult(toolCall),
  };
}

export function describeComputerUseFailures(input: ComputerUseFailureInput): ComputerUseFailureExplanation[] {
  const items: ComputerUseFailureExplanation[] = [];

  if (!input.nativeAvailable) {
    addExplanation(items, {
      id: 'native-runtime-unavailable',
      title: '当前是 Web / 非 Tauri 模式',
      detail: '没有 Tauri native bridge 时，macOS 权限、前台 app 和系统设置入口都会降级；只能读取 desktop domain 已暴露的状态。',
      tone: 'warning',
    });
  }

  if (input.desktopProviderError) {
    addExplanation(items, {
      id: 'desktop-provider-error',
      title: 'Computer/Desktop provider 未返回',
      detail: input.desktopProviderError,
      tone: 'blocked',
    });
  }

  if (input.capabilities && !input.capabilities.supportsFrontmostContext) {
    addExplanation(items, {
      id: 'frontmost-unsupported',
      title: '前台窗口上下文不可读',
      detail: '当前 native desktop provider 不能读取 frontmost app/window，窗口列表只能降级到最近活动或空状态。',
      tone: 'warning',
    });
  }

  explainPermission(items, getNativePermissionStatus(input.permissions, 'screenCapture'), 'screenCapture', input.screenCaptureOptional);
  explainPermission(items, getNativePermissionStatus(input.permissions, 'accessibility'), 'accessibility');

  addExplanation(items, {
    id: 'automation-per-app',
    title: 'Automation 是按目标 app 授权',
    detail: 'macOS 没有一个可复用的全局 Automation 状态。Apple Events / browser URL 读取会按目标 app 单独触发或失败，当前页只展示这个边界。',
    tone: 'neutral',
  });

  if (!input.surface) {
    addExplanation(items, {
      id: 'surface-missing',
      title: 'Computer Surface 状态为空',
      detail: 'desktop domain 没有返回 Computer Surface state，无法判断后台 AX、后台 CGEvent 或前台兜底是否可用。',
      tone: 'blocked',
    });
  }

  const surface = input.surface;
  if (surface?.blockedReason) {
    addExplanation(items, {
      id: 'surface-blocked',
      title: 'Computer Surface 被阻塞',
      detail: surface.blockedReason,
      tone: 'blocked',
    });
  }

  if (surface?.failureKind) {
    addExplanation(items, {
      id: `failure:${surface.failureKind}`,
      ...explainFailureKind(surface.failureKind),
    });
  }

  for (const reason of surface?.blockingReasons || []) {
    addExplanation(items, {
      id: `blocking:${reason}`,
      title: '阻塞原因',
      detail: reason,
      tone: 'blocked',
    });
  }

  if (surface?.mode === 'foreground_fallback' || surface?.requiresForeground) {
    addExplanation(items, {
      id: 'foreground-fallback',
      title: '只能前台兜底',
      detail: '当前模式会作用在前台 app/window。目标 app 不在前台或焦点被抢走时，点击和输入都不应该自动执行。',
      tone: 'warning',
    });
  }

  if (surface?.mode === 'background_surface_unavailable') {
    addExplanation(items, {
      id: 'background-unavailable',
      title: '后台控制面不可用',
      detail: surface.safetyNote || '当前没有可用的后台 AX / CGEvent surface，只能保留只读诊断。',
      tone: 'blocked',
    });
  }

  if (surface?.axQuality?.grade === 'poor') {
    addExplanation(items, {
      id: 'ax-quality-poor',
      title: 'AX tree 可读性差',
      detail: surface.axQuality.reasons.join('；') || '元素标签或 axPath 覆盖不足，不能安全定位。',
      tone: 'warning',
    });
  }

  if (input.elementsError) {
    addExplanation(items, {
      id: 'elements-error',
      title: '可操作元素读取失败',
      detail: input.selectedTargetApp
        ? `${input.selectedTargetApp}: ${input.elementsError}`
        : input.elementsError,
      tone: 'blocked',
    });
  }

  if (input.observeError) {
    addExplanation(items, {
      id: 'observe-error',
      title: '前台窗口观察失败',
      detail: input.observeError,
      tone: 'warning',
    });
  }

  if (input.targets.length === 0) {
    addExplanation(items, {
      id: 'no-targets',
      title: '没有可展示的 app/window 候选',
      detail: '没有 frontmost context、recent desktop events 或已批准 app。当前页只能展示 provider 和权限状态。',
      tone: 'neutral',
    });
  }

  return items;
}
