import type {
  BackgroundCgEventWindow,
  BackgroundCgEventWindowPoint,
  ListBackgroundCgEventWindowsOptions,
  DisplayInfo,
} from './backgroundCgEventSurface';
import { backgroundCgEventSurface } from './backgroundCgEventSurface';
import { isMultiAgentMode } from '../multiAgentMode';
import type {
  ComputerSurfaceAxQuality,
  ComputerSurfaceFailureKind,
  ComputerSurfaceMode,
  ComputerSurfaceSnapshot,
  ComputerSurfaceState,
  WorkbenchActionTrace,
} from '../../../shared/contract/desktop';
import {
  DEFAULT_DENIED_APPS,
  buildDeniedComputerSurfaceBlock,
  canUseBackgroundAxComputerSurfaceAction,
  canUseBackgroundCgEventComputerSurfaceAction,
  canUseComputerSurfaceBackground,
  computerSurfaceModeRequiresForeground,
  getComputerSurfaceSafetyNote,
  getDefaultComputerSurfaceMode,
  isBackgroundCgEventComputerSurfaceAction,
  isComputerSurfaceLaunchAction,
  isComputerSurfaceModeReady,
  isDeniedComputerSurfaceApp,
  isReadBlockedComputerSurfaceApp,
  isSensitiveComputerSurfaceAction,
  parseComputerSurfaceAppList,
  redactComputerSurfaceAction,
  type ComputerSurfacePreflightBlock,
} from './computerSurfaceSafety';
import { BackgroundAxBridge } from './backgroundAxBridge';
import {
  backgroundCgEventMetadata,
  formatAppDiagnosis,
  formatBounds,
  formatExecError,
  formatVisibleAppSummary,
  formatWindowObservationOutput,
  getWindowResultLimit,
  getWindowTargetMatches,
  hasWindowTargetIntent,
  normalizeBackgroundCgEventRequest,
  roundPoint,
  sameAppName,
} from './backgroundCgEventBridge';
import {
  getComputerSurfaceProcessStatus,
  getFrontmostComputerSurfaceContext,
  getTargetComputerSurfaceContext,
} from './computerSurfaceContext';
import { buildComputerSurfaceActionEvidenceSummary } from './computerSurfaceEvidence';
import {
  captureComputerSurfaceAppScreenshot,
  captureComputerSurfaceScreenshot,
} from './computerSurfaceScreenshots';
import { buildAgentPointerEventFromToolCall } from '../../../shared/utils/agentPointer';

export interface ComputerSurfacePermissionContext {
  sessionId?: string;
  requestPermission?: (request: {
    sessionId?: string;
    forceConfirm?: boolean;
    type: 'command' | 'dangerous_command';
    tool: string;
    details: Record<string, unknown>;
    reason?: string;
    dangerLevel?: 'normal' | 'warning' | 'danger';
  }) => Promise<boolean>;
}

export interface ComputerSurfaceAction {
  action: string;
  targetApp?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  pid?: number;
  windowId?: number;
  windowRef?: string;
  bundleId?: string;
  title?: string;
  windowLocalPoint?: BackgroundCgEventWindowPoint;
  windowX?: number;
  windowY?: number;
  button?: 'left' | 'right';
  clickCount?: number;
  toX?: number;
  toY?: number;
  selector?: string;
  role?: string;
  name?: string;
  axPath?: string;
  exact?: boolean;
  timeout?: number;
  limit?: number;
  maxDepth?: number;
}

export interface ComputerSurfaceActionResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ComputerSurfaceAuthorization {
  allowed: boolean;
  reason?: string;
  state: ComputerSurfaceState;
  trace: WorkbenchActionTrace;
  sensitive: boolean;
  failureKind?: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction?: string | null;
}

type ComputerSurfaceApprovalScope = NonNullable<ComputerSurfaceState['approvalScope']>;

class DesktopComputerSurface {
  private readonly id = 'default-computer-surface';
  private approvedAppScopes = new Set<string>();
  private lastAction: WorkbenchActionTrace | null = null;
  private lastSnapshot: ComputerSurfaceSnapshot | null = null;
  private displayInfo: DisplayInfo | null = null;
  private lastAnalyzedImageDims: { width: number; height: number } | null = null;
  private deniedApps = parseComputerSurfaceAppList(process.env.CODE_AGENT_COMPUTER_DENIED_APPS, DEFAULT_DENIED_APPS);
  private allowedApps = parseComputerSurfaceAppList(process.env.CODE_AGENT_COMPUTER_ALLOWED_APPS, []);
  private backgroundEnabled = process.env.CODE_AGENT_COMPUTER_BACKGROUND_SURFACE !== '0';
  private backgroundAxBridge = new BackgroundAxBridge();

  async getDisplayInfo(forceRefresh = false): Promise<DisplayInfo | null> {
    if (this.displayInfo && !forceRefresh) return this.displayInfo;
    if (process.platform !== 'darwin') return null;
    try {
      this.displayInfo = await backgroundCgEventSurface.getDisplayInfo();
    } catch {
      this.displayInfo = null;
    }
    return this.displayInfo;
  }

  /** 记录最近一次视觉分析截图的实际像素尺寸（screenshot 工具在 analyze 后调用） */
  setLastAnalyzedImageDims(dims: { width: number; height: number } | null): void {
    this.lastAnalyzedImageDims = dims;
  }

  getLastAnalyzedImageDims(): { width: number; height: number } | null {
    return this.lastAnalyzedImageDims;
  }

  async observe(options: { includeScreenshot?: boolean; targetApp?: string } = {}): Promise<ComputerSurfaceSnapshot> {
    if (options.targetApp && this.isReadBlockedApp(options.targetApp)) {
      const blocked = this.buildDeniedAppBlock('observe');
      const snapshot = {
        capturedAtMs: Date.now(),
        appName: null,
        windowTitle: null,
        failureKind: blocked.failureKind,
        blockingReasons: blocked.blockingReasons,
        recommendedAction: blocked.recommendedAction,
      } as ComputerSurfaceSnapshot & ComputerSurfacePreflightBlock;
      this.lastSnapshot = snapshot;
      return snapshot;
    }

    const snapshot: ComputerSurfaceSnapshot = {
      capturedAtMs: Date.now(),
      ...(options.targetApp && this.canUseBackgroundSurface()
        ? await getTargetComputerSurfaceContext(options.targetApp)
        : await getFrontmostComputerSurfaceContext()),
    };

    if (options.includeScreenshot && process.platform === 'darwin') {
      if (options.targetApp) {
        // Multi-agent mode 下截 targetApp 窗口区域，防止子 agent 看到对方桌面活动；
        // 默认（单 agent）下保留原行为——有 targetApp 时不截图（避免泄露其它窗口）。
        if (isMultiAgentMode()) {
          const cropped = await this.screenshotApp(options.targetApp).catch(() => null);
          if (cropped) snapshot.screenshotPath = cropped;
        }
      } else {
        snapshot.screenshotPath = await this.screenshot();
      }
    }

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async screenshot(): Promise<string> {
    return captureComputerSurfaceScreenshot();
  }

  async screenshotApp(targetApp: string): Promise<string | null> {
    return captureComputerSurfaceAppScreenshot(targetApp);
  }

  async executeBackgroundAction(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    if (action.targetApp && this.isDeniedApp(action.targetApp)) {
      return this.deniedAppActionResult('background Accessibility action');
    }

    if (!this.canUseBackgroundAxAction(action) || !action.targetApp) {
      return {
        success: false,
        error: 'Background Computer Surface requires targetApp plus axPath or role/name/selector, and does not support coordinate actions.',
      };
    }

    return this.backgroundAxBridge.executeAction(action);
  }

  async listBackgroundElements(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    const targetApp = action.targetApp;
    if (!targetApp) {
      return {
        success: false,
        error: 'targetApp is required for get_ax_elements.',
      };
    }

    if (!this.canUseBackgroundSurface()) {
      return {
        success: false,
        error: 'Background Computer Surface is not available on this platform.',
      };
    }

    if (this.isReadBlockedApp(targetApp)) {
      return this.deniedAppActionResult('accessibility read');
    }

    return this.backgroundAxBridge.listElements(action);
  }

  async locateBackgroundElement(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    const targetApp = action.targetApp;
    if (!targetApp) {
      return {
        success: false,
        error: 'targetApp is required for desktop locate_role.',
      };
    }
    if (!action.role) {
      return {
        success: false,
        error: 'role required for locate_role',
      };
    }

    const listResult = await this.listBackgroundElements(action);
    return this.backgroundAxBridge.locateElementFromList(action, listResult);
  }

  async listBackgroundCgEventWindows(
    options: ListBackgroundCgEventWindowsOptions = {},
  ): Promise<ComputerSurfaceActionResult> {
    if (options.targetApp && this.isReadBlockedApp(options.targetApp)) {
      return this.deniedAppActionResult('window listing', {
        computerSurfaceMode: 'background_cgevent',
      });
    }

    if (!this.canUseBackgroundSurface()) {
      return {
        success: false,
        error: 'Background CGEvent Computer Surface is not available on this platform.',
      };
    }

    try {
      const primaryWindows = await backgroundCgEventSurface.listWindows(options);
      const relaxedFallback = await this.getRelaxedTargetWindowFallback(options, primaryWindows);
      const windows = relaxedFallback?.targetMatches || primaryWindows;
      const targetMatches = getWindowTargetMatches(windows, options);
      const visibleWindows = relaxedFallback?.visibleWindows || windows;
      const recommendedWindow = windows.find((window) => window.recommended) || windows[0] || null;
      const output = formatWindowObservationOutput({
        windows,
        targetMatches,
        visibleWindows,
        options,
        recommendedWindow,
      });
      return {
        success: true,
        output,
        metadata: {
          backgroundSurface: true,
          computerSurfaceMode: 'background_cgevent',
          targetApp: options.targetApp || null,
          windows,
          targetWindowCount: windows.length,
          recommendedWindow,
          targetMatches,
          targetMatchCount: targetMatches.length,
          visibleAppSummary: formatVisibleAppSummary(visibleWindows),
          usedRelaxedTargetFallback: relaxedFallback?.used === true,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Background CGEvent window listing failed: ${formatExecError(error)}`,
        metadata: {
          backgroundSurface: true,
          computerSurfaceMode: 'background_cgevent',
          failureKind: 'evidence_unavailable',
          blockingReasons: [formatExecError(error)],
          recommendedAction: 'Check macOS screen recording/window access and retry get_windows.',
        },
      };
    }
  }

  private async getRelaxedTargetWindowFallback(
    options: ListBackgroundCgEventWindowsOptions,
    primaryWindows: BackgroundCgEventWindow[],
  ): Promise<{ used: true; targetMatches: BackgroundCgEventWindow[]; visibleWindows: BackgroundCgEventWindow[] } | null> {
    if (primaryWindows.length > 0 || !hasWindowTargetIntent(options)) {
      return null;
    }
    const relaxedLimit = Math.max(getWindowResultLimit(options), 80);
    const visibleWindows = await backgroundCgEventSurface.listWindows({
      limit: relaxedLimit,
      timeoutMs: options.timeoutMs,
    });
    const targetMatches = getWindowTargetMatches(visibleWindows, options)
      .slice(0, getWindowResultLimit(options));
    if (targetMatches.length === 0) {
      return {
        used: true,
        targetMatches: [],
        visibleWindows,
      };
    }
    return {
      used: true,
      targetMatches,
      visibleWindows,
    };
  }

  async executeBackgroundCgEventAction(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    if (action.targetApp && this.isDeniedApp(action.targetApp)) {
      return this.deniedAppActionResult('background CGEvent action', {
        computerSurfaceMode: 'background_cgevent',
      });
    }

    const normalized = normalizeBackgroundCgEventRequest(action);
    if (!normalized) {
      return {
        success: false,
        error: 'Background CGEvent action requires pid, windowId, and windowLocalPoint/windowX/windowY.',
      };
    }

    try {
      const result = await backgroundCgEventSurface.clickWindow(normalized);
      return {
        success: true,
        output: [
          `Background CGEvent ${action.action} completed: ${result.appName}`,
          `pid=${result.pid} windowId=${result.windowId}`,
          result.windowRef ? `windowRef=${result.windowRef}` : null,
          result.bundleId ? `bundleId=${result.bundleId}` : null,
          result.title ? `title="${result.title}"` : null,
          `bounds=${formatBounds(result.bounds)}`,
          `windowLocal=(${roundPoint(result.windowLocalPoint.x)}, ${roundPoint(result.windowLocalPoint.y)})`,
          `screen=(${roundPoint(result.screenPoint.x)}, ${roundPoint(result.screenPoint.y)})`,
          `active=${result.isTargetActive ? 'yes' : 'no'}`,
          `usedWindowLocation=${result.usedWindowLocation ? 'yes' : 'no'}`,
          result.eventNumbers?.length ? `eventNumbers=${result.eventNumbers.join(',')}` : null,
          `button=${result.button} clickCount=${result.clickCount}`,
        ].filter(Boolean).join(' · '),
        metadata: backgroundCgEventMetadata(result),
      };
    } catch (error) {
      return {
        success: false,
        error: `Background CGEvent action failed: ${formatExecError(error)}`,
      };
    }
  }

  async diagnoseApp(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    if (action.targetApp && this.isReadBlockedApp(action.targetApp)) {
      return this.deniedAppActionResult('app diagnosis', {
        computerSurfaceMode: 'background_cgevent',
      });
    }

    if (!this.canUseBackgroundSurface()) {
      return {
        success: false,
        error: 'Computer Surface app diagnosis is not available on this platform.',
      };
    }

    try {
      const diagnosis = await backgroundCgEventSurface.diagnoseApp({
        targetApp: action.targetApp,
        bundleId: action.bundleId,
        title: action.title,
        pid: action.pid,
        windowId: action.windowId,
        limit: action.limit,
        timeoutMs: action.timeout,
      });
      return {
        success: true,
        output: formatAppDiagnosis(diagnosis),
        metadata: {
          backgroundSurface: true,
          computerSurfaceMode: 'background_cgevent',
          targetApp: action.targetApp || null,
          appDiagnosis: diagnosis,
          recommendedWindow: diagnosis.recommendedWindow || null,
          windows: diagnosis.windows,
          targetWindowCount: diagnosis.windows.length,
          tcc: diagnosis.permissions,
          axSuitable: diagnosis.ax.suitable,
          cgEventSuitable: diagnosis.cgEvent.suitable,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Computer Surface app diagnosis failed: ${formatExecError(error)}`,
        metadata: {
          backgroundSurface: true,
          computerSurfaceMode: 'background_cgevent',
          targetApp: action.targetApp || null,
          failureKind: 'evidence_unavailable',
          blockingReasons: [formatExecError(error)],
          recommendedAction: 'Check Xcode command line tools, Screen Recording, Accessibility, and retry diagnose_app.',
        },
      };
    }
  }

  async authorizeAction(
    action: ComputerSurfaceAction,
    context: ComputerSurfacePermissionContext = {},
  ): Promise<ComputerSurfaceAuthorization> {
    const actionMode = this.resolveActionMode(action);
    if (action.targetApp && this.isDeniedApp(action.targetApp)) {
      const mode = actionMode;
      const blockingReasons = this.buildDeniedAppBlock('automation').blockingReasons;
      const recommendedAction = this.buildDeniedAppBlock('automation').recommendedAction;
      const trace: WorkbenchActionTrace = {
        id: `computer_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        targetKind: 'computer',
        toolName: 'computer_use',
        action: action.action,
        mode,
        startedAtMs: Date.now(),
        before: {
          appName: null,
          title: null,
          screenshotPath: null,
          capturedAtMs: Date.now(),
        },
        params: { protectedTarget: true },
        failureKind: 'permission_denied',
        blockingReasons,
        recommendedAction,
      };
      return {
        allowed: false,
        reason: blockingReasons[0],
        state: this.getState({
          targetApp: null,
          blockedReason: 'protected app',
          approvalScope: 'blocked',
          mode,
          failureKind: 'permission_denied',
          blockingReasons,
          recommendedAction,
        }),
        trace,
        sensitive: false,
        failureKind: 'permission_denied',
        blockingReasons,
        recommendedAction,
      };
    }

    const before = await this.observe({
      targetApp: actionMode === 'background_ax' || actionMode === 'background_cgevent'
        ? action.targetApp
        : undefined,
    });
    const targetApp = action.targetApp || before.appName || null;
    const mode = action.targetApp && targetApp
      ? this.resolveActionMode({ ...action, targetApp })
      : actionMode;
    const trace: WorkbenchActionTrace = {
      id: `computer_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetKind: 'computer',
      toolName: 'computer_use',
      action: action.action,
      mode,
      startedAtMs: Date.now(),
      before: {
        appName: before.appName || null,
        title: before.windowTitle || null,
        screenshotPath: before.screenshotPath || null,
        capturedAtMs: before.capturedAtMs,
      },
      params: redactComputerSurfaceAction(action),
    };

    const preflightBlock = await this.preflightAction(action, {
      before,
      targetApp,
      mode,
    });
    if (preflightBlock) {
      const failureTrace: WorkbenchActionTrace = {
        ...trace,
        failureKind: preflightBlock.failureKind,
        blockingReasons: preflightBlock.blockingReasons,
        recommendedAction: preflightBlock.recommendedAction,
      };
      return {
        allowed: false,
        reason: preflightBlock.blockingReasons.join(' '),
        state: this.getState({
          targetApp,
          blockedReason: preflightBlock.blockingReasons.join(' '),
          approvalScope: 'blocked',
          mode,
          failureKind: preflightBlock.failureKind,
          blockingReasons: preflightBlock.blockingReasons,
          recommendedAction: preflightBlock.recommendedAction,
        }),
        trace: failureTrace,
        sensitive: false,
        failureKind: preflightBlock.failureKind,
        blockingReasons: preflightBlock.blockingReasons,
        recommendedAction: preflightBlock.recommendedAction,
      };
    }

    if (!targetApp) {
      const blockingReasons = ['Computer Surface cannot determine the target app.'];
      return {
        allowed: false,
        reason: blockingReasons[0],
        state: this.getState({
          targetApp,
          blockedReason: 'target app unknown',
          approvalScope: 'blocked',
          mode,
          failureKind: 'locator_missing',
          blockingReasons,
          recommendedAction: 'Run computer_use.observe first, then retry with targetApp or a concrete locator.',
        }),
        trace: {
          ...trace,
          failureKind: 'locator_missing',
          blockingReasons,
          recommendedAction: 'Run computer_use.observe first, then retry with targetApp or a concrete locator.',
        },
        sensitive: false,
        failureKind: 'locator_missing',
        blockingReasons,
        recommendedAction: 'Run computer_use.observe first, then retry with targetApp or a concrete locator.',
      };
    }

    if (mode === 'foreground_fallback' && action.targetApp && !isComputerSurfaceLaunchAction(action.action)) {
      const frontmostApp = before.appName || null;
      if (!frontmostApp || !sameAppName(frontmostApp, action.targetApp)) {
        const current = frontmostApp || 'unknown frontmost app';
        const blockingReasons = [
          `Computer Surface foreground fallback requires the target app to be frontmost. Requested ${action.targetApp}, current frontmost is ${current}.`,
        ];
        const recommendedAction = `Bring ${action.targetApp} to the foreground, then retry the foreground fallback action.`;
        return {
          allowed: false,
          reason: blockingReasons[0],
          state: this.getState({
            targetApp: action.targetApp,
            blockedReason: `target app is not foreground: current ${current}`,
            approvalScope: 'blocked',
            mode,
            failureKind: 'target_not_frontmost',
            blockingReasons,
            recommendedAction,
          }),
          trace: {
            ...trace,
            failureKind: 'target_not_frontmost',
            blockingReasons,
            recommendedAction,
          },
          sensitive: false,
          failureKind: 'target_not_frontmost',
          blockingReasons,
          recommendedAction,
        };
      }
    }

    if (this.isDeniedApp(targetApp)) {
      const { blockingReasons, recommendedAction } = this.buildDeniedAppBlock('automation');
      return {
        allowed: false,
        reason: blockingReasons[0],
        state: this.getState({
          targetApp: null,
          blockedReason: 'protected app',
          approvalScope: 'blocked',
          mode,
          failureKind: 'permission_denied',
          blockingReasons,
          recommendedAction,
        }),
        trace: {
          ...trace,
          before: {
            appName: null,
            title: null,
            screenshotPath: null,
            capturedAtMs: trace.before?.capturedAtMs,
          },
          params: { protectedTarget: true },
          failureKind: 'permission_denied',
          blockingReasons,
          recommendedAction,
        },
        sensitive: false,
        failureKind: 'permission_denied',
        blockingReasons,
        recommendedAction,
      };
    }

    const sensitive = isSensitiveComputerSurfaceAction(action);
    const approvedByPolicy = this.allowedApps.length > 0
      ? this.allowedApps.some((item) => item.toLowerCase() === targetApp.toLowerCase())
      : this.approvedAppScopes.has(this.approvalKey(targetApp, mode, context.sessionId));

    if (!approvedByPolicy || sensitive) {
      const approved = await context.requestPermission?.({
        sessionId: context.sessionId,
        forceConfirm: sensitive,
        type: sensitive ? 'dangerous_command' : 'command',
        tool: 'computer_use',
        details: {
          targetApp,
          action: action.action,
          surfaceMode: mode,
          background: mode === 'background_ax' || mode === 'background_cgevent',
          requiresForeground: computerSurfaceModeRequiresForeground(mode),
          approvalScope: sensitive ? 'per_action' : 'session_app',
          safetyNote: getComputerSurfaceSafetyNote(mode),
          fallback: mode === 'foreground_fallback',
        },
        reason: sensitive
          ? 'Sensitive Computer Use action requires explicit confirmation.'
          : mode === 'background_ax'
            ? `Approve background Accessibility Computer Use for ${targetApp}.`
            : mode === 'background_cgevent'
              ? `Approve background CGEvent click for ${targetApp}.`
            : `Approve Computer Use for the current foreground ${targetApp} window.`,
        dangerLevel: sensitive ? 'danger' : 'warning',
      });

      if (!approved) {
        const blockingReasons = [
          sensitive
            ? 'Sensitive Computer Use action was not approved.'
            : `Computer Use for ${targetApp} was not approved.`,
        ];
        const recommendedAction = sensitive
          ? 'Confirm the sensitive Computer Use action explicitly if it is intentional.'
          : `Approve Computer Use for ${targetApp}, then retry.`;
        return {
          allowed: false,
          reason: blockingReasons[0],
          state: this.getState({
            targetApp,
            blockedReason: 'approval required',
            approvalScope: sensitive ? 'per_action' : 'session_app',
            mode,
            failureKind: 'permission_denied',
            blockingReasons,
            recommendedAction,
          }),
          trace: {
            ...trace,
            failureKind: 'permission_denied',
            blockingReasons,
            recommendedAction,
          },
          sensitive,
          failureKind: 'permission_denied',
          blockingReasons,
          recommendedAction,
        };
      }

      if (!sensitive) {
        this.approvedAppScopes.add(this.approvalKey(targetApp, mode, context.sessionId));
      }
    }

    return {
      allowed: true,
      state: this.getState({ targetApp, approvalScope: sensitive ? 'per_action' : 'session_app', mode }),
      trace,
      sensitive,
    };
  }

  private async preflightAction(
    action: ComputerSurfaceAction,
    args: {
      before: ComputerSurfaceSnapshot;
      targetApp: string | null;
      mode: ComputerSurfaceMode;
    },
  ): Promise<ComputerSurfacePreflightBlock | null> {
    if (process.platform !== 'darwin' || args.mode === 'background_surface_unavailable') {
      return {
        failureKind: 'ax_unavailable',
        blockingReasons: [`Computer Surface is not available on ${process.platform}.`],
        recommendedAction: 'Use Browser/Managed mode or run Computer Use on macOS.',
      };
    }

    if (isBackgroundCgEventComputerSurfaceAction(action.action) && hasBackgroundCgEventTargetFragment(action)) {
      if (!action.targetApp) {
        return {
          failureKind: 'target_window_not_found',
          blockingReasons: ['Background CGEvent action needs an explicit targetApp plus pid, windowId, and windowLocalPoint/windowX/windowY from computer_use.get_windows.'],
          recommendedAction: 'Run computer_use.get_windows, choose the target window, then retry with targetApp, pid, windowId, and a window-local point.',
        };
      }
      if (!normalizeBackgroundCgEventRequest(action)) {
        return {
          failureKind: 'target_window_not_found',
          blockingReasons: ['Background CGEvent action needs targetApp, pid, windowId, and windowLocalPoint/windowX/windowY from computer_use.get_windows.'],
          recommendedAction: 'Run computer_use.get_windows, choose the target window, then retry with pid, windowId, and a window-local point.',
        };
      }
    }

    if (args.mode === 'background_cgevent' && !normalizeBackgroundCgEventRequest(action)) {
      return {
        failureKind: 'target_window_not_found',
        blockingReasons: ['Background CGEvent action needs targetApp, pid, windowId, and windowLocalPoint/windowX/windowY from computer_use.get_windows.'],
        recommendedAction: 'Run computer_use.get_windows, choose the target window, then retry with pid, windowId, and a window-local point.',
      };
    }

    if (!args.targetApp) {
      return {
        failureKind: 'locator_missing',
        blockingReasons: ['Computer Surface could not determine a target app/window.'],
        recommendedAction: 'Run computer_use.observe first, then retry with targetApp or a concrete locator.',
      };
    }

    if (action.targetApp && !isComputerSurfaceLaunchAction(action.action)) {
      const targetStatus = await getComputerSurfaceProcessStatus(action.targetApp);
      if (targetStatus.permissionDenied) {
        return {
          failureKind: 'permission_denied',
          blockingReasons: targetStatus.error
            ? [`Accessibility/System Events permission check failed: ${targetStatus.error}`]
            : ['Accessibility/System Events permission check failed.'],
          recommendedAction: 'Grant Accessibility permission in System Settings, then restart the app if macOS asks for it.',
        };
      }
      if (targetStatus.running === false) {
        return {
          failureKind: 'target_app_not_running',
          blockingReasons: [`Target app is not running: ${action.targetApp}.`],
          recommendedAction: `Open ${action.targetApp}, then retry the Computer Use action.`,
        };
      }
      if (args.mode === 'background_ax' && !args.before.appName) {
        return {
          failureKind: 'target_app_not_running',
          blockingReasons: [`Target app is not running or did not expose a window: ${action.targetApp}.`],
          recommendedAction: `Open ${action.targetApp} and make sure it has a visible window, then retry the Computer Use action.`,
        };
      }
    }

    return null;
  }

  async recordAction(
    trace: WorkbenchActionTrace,
    args: {
      success: boolean;
      error?: string | null;
      failureKind?: ComputerSurfaceFailureKind | null;
      blockingReasons?: string[];
      recommendedAction?: string | null;
      evidenceSummary?: string[];
      axQuality?: ComputerSurfaceAxQuality | null;
      resultMetadata?: Record<string, unknown>;
    },
  ): Promise<WorkbenchActionTrace> {
    const targetApp = typeof trace.params?.targetApp === 'string' ? trace.params.targetApp : undefined;
    const after = await this.observe({
      targetApp: trace.mode === 'background_ax' || trace.mode === 'background_cgevent'
        ? targetApp || trace.before?.appName || undefined
        : undefined,
    });
    const evidenceSummary = args.evidenceSummary || buildComputerSurfaceActionEvidenceSummary(trace, after);
    const failureKind = args.failureKind ?? trace.failureKind ?? (args.success ? null : 'action_execution_failed');
    const blockingReasons = args.blockingReasons
      || trace.blockingReasons
      || (args.error ? [args.error] : undefined);
    const recommendedAction = args.recommendedAction
      ?? trace.recommendedAction
      ?? (!args.success ? 'Inspect the before/after evidence and retry with observe or AX candidates before another mutating action.' : null);
    const completed: WorkbenchActionTrace = {
      ...trace,
      completedAtMs: Date.now(),
      success: args.success,
      error: args.error || null,
      after: {
        appName: after.appName || null,
        title: after.windowTitle || null,
        screenshotPath: after.screenshotPath || null,
        capturedAtMs: after.capturedAtMs,
      },
      failureKind,
      blockingReasons,
      recommendedAction,
      evidenceSummary,
      axQuality: args.axQuality ?? trace.axQuality ?? null,
    };
    const agentPointerEvent = buildAgentPointerEventFromToolCall({
      id: completed.id,
      name: completed.toolName || 'computer_use',
      arguments: {
        action: completed.action,
        ...(completed.params || {}),
      },
      result: {
        success: args.success,
        error: args.error || undefined,
        metadata: {
          ...(args.resultMetadata || {}),
          traceId: completed.id,
          workbenchTrace: completed,
          targetApp: targetApp || completed.before?.appName || after.appName || null,
        },
      },
    });
    const completedWithPointer: WorkbenchActionTrace = {
      ...completed,
      agentPointerEvent,
    };
    this.lastAction = completedWithPointer;
    return completedWithPointer;
  }

  getState(overrides: {
    targetApp?: string | null;
    blockedReason?: string | null;
    approvalScope?: ComputerSurfaceApprovalScope;
    mode?: ComputerSurfaceMode;
    failureKind?: ComputerSurfaceFailureKind | null;
    blockingReasons?: string[];
    recommendedAction?: string | null;
    evidenceSummary?: string[];
    axQuality?: ComputerSurfaceAxQuality | null;
  } = {}): ComputerSurfaceState {
    const mode = overrides.mode || this.getDefaultMode();
    const blockedReason = overrides.blockedReason || null;
    return {
      id: this.id,
      mode,
      platform: process.platform,
      ready: isComputerSurfaceModeReady(mode),
      background: mode === 'background_ax' || mode === 'background_cgevent',
      requiresForeground: computerSurfaceModeRequiresForeground(mode),
      approvalScope: this.resolveApprovalScope(mode, blockedReason, overrides.approvalScope),
      safetyNote: getComputerSurfaceSafetyNote(mode),
      targetApp: overrides.targetApp ?? this.lastSnapshot?.appName ?? null,
      blockedReason,
      approvedApps: Array.from(this.approvedAppScopes).sort(),
      deniedApps: [...this.deniedApps],
      lastAction: this.lastAction,
      lastSnapshot: this.lastSnapshot,
      failureKind: overrides.failureKind ?? null,
      blockingReasons: overrides.blockingReasons,
      recommendedAction: overrides.recommendedAction ?? null,
      evidenceSummary: overrides.evidenceSummary,
      axQuality: overrides.axQuality ?? null,
    };
  }

  private getDefaultMode(): ComputerSurfaceMode {
    return getDefaultComputerSurfaceMode({ backgroundEnabled: this.backgroundEnabled });
  }

  private resolveActionMode(action: ComputerSurfaceAction): ComputerSurfaceMode {
    if (this.canUseBackgroundCgEventAction(action)) {
      return 'background_cgevent';
    }
    if (this.canUseBackgroundAxAction(action)) {
      return 'background_ax';
    }
    return process.platform === 'darwin'
      ? 'foreground_fallback'
      : 'background_surface_unavailable';
  }

  private canUseBackgroundSurface(): boolean {
    return canUseComputerSurfaceBackground(this.backgroundEnabled);
  }

  private isDeniedApp(targetApp: string): boolean {
    return isDeniedComputerSurfaceApp(targetApp, this.deniedApps);
  }

  /**
   * 只读 Computer Surface 操作（observe / get_ax_elements / get_windows /
   * diagnose_app）的门禁：被保护的 app 一律拦，但 Agent Neo 自身豁免。
   *
   * 自操作真正该拦的是 reentrancy —— agent loop 通过 computer-use 驱动自己的
   * 输入/run 入口形成递归咬尾。而读自己的 UI 状态（设置页 / 会话列表 / AX 树）
   * 物理上不可能造成 reentrancy，是合理且更智能的自操作能力。写路径仍走
   * isDeniedApp 全拦，self-write 收窄留到后续 reentrancy 护栏阶段再做。
   * 注意：仅豁免 self —— 其它被保护 app（1Password / Keychain 等）读操作仍全拦，
   * 它们的 UI/AX 树本身可能泄露敏感信息。
   */
  private isReadBlockedApp(targetApp: string): boolean {
    return isReadBlockedComputerSurfaceApp(targetApp, this.deniedApps);
  }

  private buildDeniedAppBlock(actionDescription: string): ComputerSurfacePreflightBlock {
    return buildDeniedComputerSurfaceBlock(actionDescription);
  }

  private deniedAppActionResult(
    actionDescription: string,
    metadata: Record<string, unknown> = {},
  ): ComputerSurfaceActionResult {
    const blocked = this.buildDeniedAppBlock(actionDescription);
    return {
      success: false,
      error: blocked.blockingReasons[0],
      metadata: {
        backgroundSurface: true,
        targetApp: null,
        failureKind: blocked.failureKind,
        blockingReasons: blocked.blockingReasons,
        recommendedAction: blocked.recommendedAction,
        ...metadata,
      },
    };
  }

  private canUseBackgroundAxAction(action: ComputerSurfaceAction): boolean {
    return canUseBackgroundAxComputerSurfaceAction(action, {
      backgroundAvailable: this.canUseBackgroundSurface(),
      hasElementLocator: hasBackgroundElementLocator(action),
    });
  }

  private canUseBackgroundCgEventAction(action: ComputerSurfaceAction): boolean {
    return canUseBackgroundCgEventComputerSurfaceAction(action, {
      backgroundAvailable: this.canUseBackgroundSurface(),
      hasCgEventRequest: Boolean(normalizeBackgroundCgEventRequest(action)),
    });
  }

  private approvalKey(targetApp: string, mode: ComputerSurfaceMode, sessionId?: string): string {
    const scope = sessionId?.trim() ? sessionId.trim() : 'anonymous';
    return `${scope}:${mode}:${targetApp.toLowerCase()}`;
  }

  private resolveApprovalScope(
    mode: ComputerSurfaceMode,
    blockedReason: string | null,
    override?: ComputerSurfaceApprovalScope,
  ): ComputerSurfaceApprovalScope {
    if (override) return override;
    if (blockedReason || mode === 'background_surface_unavailable') return 'blocked';
    return 'session_app';
  }

}

const computerSurface = new DesktopComputerSurface();

export function getComputerSurface(): DesktopComputerSurface {
  return computerSurface;
}

function hasBackgroundElementLocator(action: ComputerSurfaceAction): boolean {
  return Boolean(action.axPath || action.selector || (action.role && action.name));
}

function hasBackgroundCgEventTargetFragment(action: ComputerSurfaceAction): boolean {
  return action.pid !== undefined
    || action.windowId !== undefined
    || action.windowRef !== undefined
    || action.windowLocalPoint !== undefined
    || action.windowX !== undefined
    || action.windowY !== undefined;
}
