import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import type {
  BackgroundCgEventAppDiagnosis,
  BackgroundCgEventClickResult,
  BackgroundCgEventWindow,
  BackgroundCgEventWindowPoint,
  BackgroundCgEventWindowBounds,
  ListBackgroundCgEventWindowsOptions,
} from './backgroundCgEventSurface';
import { backgroundCgEventSurface } from './backgroundCgEventSurface';
import type {
  ComputerSurfaceAxQuality,
  ComputerSurfaceFailureKind,
  ComputerSurfaceMode,
  ComputerSurfaceSnapshot,
  ComputerSurfaceState,
  WorkbenchActionTrace,
} from '../../../shared/contract/desktop';

const execFileAsync = promisify(execFile);

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

interface ComputerSurfacePreflightBlock {
  failureKind: ComputerSurfaceFailureKind;
  blockingReasons: string[];
  recommendedAction: string;
}

const DEFAULT_DENIED_APPS = [
  'Terminal',
  'iTerm',
  'iTerm2',
  'Code Agent',
  'Codex',
  'System Settings',
  'System Preferences',
  'Keychain Access',
  '1Password',
];

const FOREGROUND_FALLBACK_SAFETY_NOTE =
  'Computer Surface 会作用于当前前台 app/window；没有后台隔离。';
const BACKGROUND_AX_SAFETY_NOTE =
  'Computer Surface 会通过 macOS Accessibility 操作指定 app/window；坐标类动作仍需前台窗口兜底。';
const BACKGROUND_CGEVENT_SAFETY_NOTE =
  'Computer Surface 会向指定 macOS pid/windowId 投递 CGEvent；必须先选窗口并使用窗口内坐标。';
const BACKGROUND_UNAVAILABLE_SAFETY_NOTE =
  '当前平台没有可用的 Computer Surface 后台或前台执行器。';
const BACKGROUND_AX_ACTIONS = new Set(['click', 'doubleClick', 'type']);
const BACKGROUND_CGEVENT_ACTIONS = new Set(['click', 'doubleClick', 'rightClick']);

class DesktopComputerSurface {
  private readonly id = 'default-computer-surface';
  private approvedAppScopes = new Set<string>();
  private lastAction: WorkbenchActionTrace | null = null;
  private lastSnapshot: ComputerSurfaceSnapshot | null = null;
  private deniedApps = parseList(process.env.CODE_AGENT_COMPUTER_DENIED_APPS, DEFAULT_DENIED_APPS);
  private allowedApps = parseList(process.env.CODE_AGENT_COMPUTER_ALLOWED_APPS, []);
  private backgroundEnabled = process.env.CODE_AGENT_COMPUTER_BACKGROUND_SURFACE !== '0';

  async observe(options: { includeScreenshot?: boolean; targetApp?: string } = {}): Promise<ComputerSurfaceSnapshot> {
    const snapshot: ComputerSurfaceSnapshot = {
      capturedAtMs: Date.now(),
      ...(options.targetApp && this.canUseBackgroundSurface()
        ? await this.getAppContext(options.targetApp)
        : await this.getFrontmostContext()),
    };

    if (options.includeScreenshot && process.platform === 'darwin' && !options.targetApp) {
      snapshot.screenshotPath = await this.screenshot();
    }

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async screenshot(): Promise<string> {
    const filepath = path.join(os.tmpdir(), `code-agent-computer-surface-${Date.now()}.png`);
    await execFileAsync('screencapture', ['-x', filepath]);
    return filepath;
  }

  async executeBackgroundAction(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
    if (!this.canUseBackgroundAxAction(action) || !action.targetApp) {
      return {
        success: false,
        error: 'Background Computer Surface requires targetApp plus axPath or role/name/selector, and does not support coordinate actions.',
      };
    }

    const elementName = action.name || action.selector || '';
    const role = normalizeBackgroundRole(action.role);
    const axPath = action.axPath || '';
    const scriptArgs = [
      action.targetApp,
      normalizeBackgroundAction(action.action),
      role,
      elementName,
      action.text || '',
      action.exact ? 'true' : 'false',
      axPath,
    ];

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        ...toAppleScriptArgs(BACKGROUND_AX_ACTION_SCRIPT),
        ...scriptArgs,
      ], {
        timeout: Math.max(1_000, Math.min(action.timeout || 8_000, 30_000)),
        maxBuffer: 1024 * 1024,
      }));
      const output = stdout.trim() || `Background action completed: ${action.action}`;
      return {
        success: true,
        output: action.action === 'type'
          ? `${output} text: ${action.text?.length || 0} chars`
          : output,
        metadata: {
          backgroundSurface: true,
          targetApp: action.targetApp,
          targetRole: role || null,
          targetName: elementName || null,
          targetAxPath: axPath || null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Background action failed: ${formatExecError(error)}`,
      };
    }
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

    if (this.isDeniedApp(targetApp)) {
      return {
        success: false,
        error: `Computer Surface blocked accessibility read for protected app: ${targetApp}`,
      };
    }

    const limit = clampInt(action.limit, 1, 80, 40);
    const maxDepth = clampInt(action.maxDepth, 1, 8, 4);

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        ...toAppleScriptArgs(BACKGROUND_AX_ELEMENTS_SCRIPT),
        targetApp,
        String(limit),
        String(maxDepth),
      ], {
        timeout: Math.max(1_000, Math.min(action.timeout || 8_000, 30_000)),
        maxBuffer: 1024 * 1024,
      }));
      const elements = parseBackgroundElementLines(stdout);
      const axQuality = assessAxTreeQuality(elements, elements.length >= limit);
      const poorAxTree = axQuality.grade === 'poor';
      const blockingReasons = poorAxTree
        ? [`AX tree quality is poor for ${targetApp}: ${axQuality.reasons.join('; ')}`]
        : undefined;
      const recommendedAction = poorAxTree
        ? 'Try a narrower target window, increase maxDepth, or use foreground observe before retrying the action.'
        : null;
      const output = elements.length > 0
        ? [
            `Found ${elements.length} background AX elements for ${targetApp}:`,
            ...elements.map((element) => [
              `${element.index}. ${element.role}${element.name ? ` "${element.name}"` : ''}`,
              element.axPath ? ` [axPath=${element.axPath}]` : '',
            ].join('')),
            formatAxQualityLine(axQuality),
          ].join('\n')
        : [
            `No background AX elements found for ${targetApp}.`,
            formatAxQualityLine(axQuality),
          ].join('\n');
      return {
        success: true,
        output,
        metadata: {
          backgroundSurface: true,
          targetApp,
          elements,
          targetElementCount: elements.length,
          limit,
          maxDepth,
          axQuality,
          failureKind: poorAxTree ? 'ax_tree_poor' : null,
          blockingReasons,
          recommendedAction,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Background element listing failed: ${formatExecError(error)}`,
      };
    }
  }

  async listBackgroundCgEventWindows(
    options: ListBackgroundCgEventWindowsOptions = {},
  ): Promise<ComputerSurfaceActionResult> {
    if (!this.canUseBackgroundSurface()) {
      return {
        success: false,
        error: 'Background CGEvent Computer Surface is not available on this platform.',
      };
    }

    try {
      const windows = await backgroundCgEventSurface.listWindows(options);
      const recommendedWindow = windows.find((window) => window.recommended) || windows[0] || null;
      const output = windows.length > 0
        ? [
            `Found ${windows.length} background CGEvent window candidates${formatTargetSuffix(options)}:`,
            ...windows.map(formatBackgroundCgEventWindowLine),
            recommendedWindow ? `Recommended window: ${formatBackgroundCgEventWindowLine(recommendedWindow)}` : null,
          ].join('\n')
        : `No background CGEvent window candidates found${formatTargetSuffix(options)}.`;
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

  async executeBackgroundCgEventAction(action: ComputerSurfaceAction): Promise<ComputerSurfaceActionResult> {
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
      params: redactAction(action),
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

    if (mode === 'foreground_fallback' && action.targetApp) {
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
      const blockingReasons = [`Computer Surface blocked automation for protected app: ${targetApp}`];
      const recommendedAction = 'Choose a non-protected target app or remove the app from the denied list intentionally.';
      return {
        allowed: false,
        reason: blockingReasons[0],
        state: this.getState({
          targetApp,
          blockedReason: `protected app: ${targetApp}`,
          approvalScope: 'blocked',
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
        sensitive: false,
        failureKind: 'permission_denied',
        blockingReasons,
        recommendedAction,
      };
    }

    const sensitive = isSensitiveAction(action);
    const approvedByPolicy = this.allowedApps.length > 0
      ? this.allowedApps.some((item) => item.toLowerCase() === targetApp.toLowerCase())
      : this.approvedAppScopes.has(this.approvalKey(targetApp, mode));

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
          requiresForeground: this.requiresForeground(mode),
          approvalScope: sensitive ? 'per_action' : 'session_app',
          safetyNote: this.getSafetyNote(mode),
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
        this.approvedAppScopes.add(this.approvalKey(targetApp, mode));
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

    if (BACKGROUND_CGEVENT_ACTIONS.has(action.action) && hasBackgroundCgEventTargetFragment(action)) {
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

    if (action.targetApp) {
      const targetStatus = await this.getTargetAppProcessStatus(action.targetApp);
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
    },
  ): Promise<WorkbenchActionTrace> {
    const targetApp = typeof trace.params?.targetApp === 'string' ? trace.params.targetApp : undefined;
    const after = await this.observe({
      targetApp: trace.mode === 'background_ax' || trace.mode === 'background_cgevent'
        ? targetApp || trace.before?.appName || undefined
        : undefined,
    });
    const evidenceSummary = args.evidenceSummary || this.buildActionEvidenceSummary(trace, after);
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
    this.lastAction = completed;
    return completed;
  }

  private async getTargetAppProcessStatus(targetApp: string): Promise<{
    running: boolean | null;
    permissionDenied?: boolean;
    error?: string;
  }> {
    if (process.platform !== 'darwin') {
      return { running: null };
    }

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        '-e',
        'on run argv',
        '-e',
        'set targetApp to item 1 of argv',
        '-e',
        'tell application "System Events"',
        '-e',
        'if exists application process targetApp then return "running"',
        '-e',
        'return "missing"',
        '-e',
        'end tell',
        '-e',
        'end run',
        targetApp,
      ], {
        timeout: 3_000,
        maxBuffer: 1024 * 256,
      }));
      const text = stdout.trim();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (text === 'running') return { running: true };
      if (text === 'missing') return { running: false };
      if (lines.length >= 2) return { running: true };
      if (lines.length === 1 && sameAppName(lines[0], targetApp)) return { running: false };
      return { running: false };
    } catch (error) {
      const message = formatExecError(error);
      return {
        running: null,
        permissionDenied: isLikelyAccessibilityPermissionError(message),
        error: message,
      };
    }
  }

  private buildActionEvidenceSummary(
    trace: WorkbenchActionTrace,
    after: ComputerSurfaceSnapshot,
  ): string[] {
    const beforeApp = trace.before?.appName || 'unknown app';
    const beforeTitle = trace.before?.title || 'unknown window';
    const afterApp = after.appName || 'unknown app';
    const afterTitle = after.windowTitle || 'unknown window';
    const params = trace.params || {};
    const targetApp = typeof params.targetApp === 'string' ? params.targetApp : trace.before?.appName || null;
    const targetRole = typeof params.role === 'string' ? params.role : null;
    const targetName = typeof params.name === 'string' ? params.name : null;
    const targetAxPath = typeof params.axPath === 'string' ? params.axPath : null;
    const targetSelector = typeof params.selector === 'string' ? params.selector : null;
    const pid = typeof params.pid === 'number' ? params.pid : null;
    const windowId = typeof params.windowId === 'number' ? params.windowId : null;
    const windowLocalPoint = parseWindowLocalPointFromParams(params);
    return [
      `Before: ${beforeApp} · ${beforeTitle}`,
      `After: ${afterApp} · ${afterTitle}`,
      targetApp ? `Target app: ${targetApp}` : null,
      trace.mode === 'background_ax'
        ? `AX locator: ${[targetRole, targetName, targetAxPath || targetSelector].filter(Boolean).join(' · ') || 'unknown'}`
        : null,
      trace.mode === 'background_cgevent'
        ? `CGEvent window: ${[pid ? `pid ${pid}` : null, windowId ? `window ${windowId}` : null].filter(Boolean).join(' · ') || 'unknown'}`
        : null,
      trace.mode === 'background_cgevent' && windowLocalPoint
        ? `Window local point: ${roundPoint(windowLocalPoint.x)}, ${roundPoint(windowLocalPoint.y)}`
        : null,
    ].filter(Boolean) as string[];
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
      ready: this.isReady(mode),
      background: mode === 'background_ax' || mode === 'background_cgevent',
      requiresForeground: this.requiresForeground(mode),
      approvalScope: this.resolveApprovalScope(mode, blockedReason, overrides.approvalScope),
      safetyNote: this.getSafetyNote(mode),
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
    if (this.canUseBackgroundSurface()) {
      return 'background_ax';
    }
    return process.platform === 'darwin'
      ? 'foreground_fallback'
      : 'background_surface_unavailable';
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

  private requiresForeground(mode = this.getDefaultMode()): boolean {
    return mode === 'foreground_fallback';
  }

  private isReady(mode: ComputerSurfaceMode): boolean {
    return process.platform === 'darwin' && mode !== 'background_surface_unavailable';
  }

  private getSafetyNote(mode = this.getDefaultMode()): string {
    if (mode === 'background_ax') {
      return BACKGROUND_AX_SAFETY_NOTE;
    }
    if (mode === 'background_cgevent') {
      return BACKGROUND_CGEVENT_SAFETY_NOTE;
    }
    return mode === 'foreground_fallback'
      ? FOREGROUND_FALLBACK_SAFETY_NOTE
      : BACKGROUND_UNAVAILABLE_SAFETY_NOTE;
  }

  private canUseBackgroundSurface(): boolean {
    return process.platform === 'darwin' && this.backgroundEnabled;
  }

  private isDeniedApp(targetApp: string): boolean {
    return this.deniedApps.some((item) => item.toLowerCase() === targetApp.toLowerCase());
  }

  private canUseBackgroundAxAction(action: ComputerSurfaceAction): boolean {
    return this.canUseBackgroundSurface()
      && Boolean(action.targetApp)
      && BACKGROUND_AX_ACTIONS.has(action.action)
      && hasBackgroundElementLocator(action)
      && action.x === undefined
      && action.y === undefined;
  }

  private canUseBackgroundCgEventAction(action: ComputerSurfaceAction): boolean {
    return this.canUseBackgroundSurface()
      && Boolean(action.targetApp)
      && BACKGROUND_CGEVENT_ACTIONS.has(action.action)
      && Boolean(normalizeBackgroundCgEventRequest(action));
  }

  private approvalKey(targetApp: string, mode: ComputerSurfaceMode): string {
    return `${mode}:${targetApp.toLowerCase()}`;
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

  private async getFrontmostContext(): Promise<Pick<ComputerSurfaceSnapshot, 'appName' | 'windowTitle'>> {
    if (process.platform !== 'darwin') {
      return {};
    }

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        '-e',
        'tell application "System Events" to set frontApp to first application process whose frontmost is true',
        '-e',
        'tell application "System Events" to set appName to name of frontApp',
        '-e',
        'tell application "System Events" to set winTitle to ""',
        '-e',
        'tell application "System Events" to if exists window 1 of frontApp then set winTitle to name of window 1 of frontApp',
        '-e',
        'return appName & "\n" & winTitle',
      ]));
      const [appName, ...titleParts] = stdout.trim().split('\n');
      return {
        appName: appName || null,
        windowTitle: titleParts.join('\n') || null,
      };
    } catch {
      return {};
    }
  }

  private async getAppContext(targetApp: string): Promise<Pick<ComputerSurfaceSnapshot, 'appName' | 'windowTitle'>> {
    if (process.platform !== 'darwin') {
      return {};
    }

    try {
      const stdout = getExecStdout(await execFileAsync('osascript', [
        '-e',
        'on run argv',
        '-e',
        'set targetApp to item 1 of argv',
        '-e',
        'tell application "System Events"',
        '-e',
        'if not (exists application process targetApp) then return targetApp & "\n"',
        '-e',
        'tell application process targetApp',
        '-e',
        'set winTitle to ""',
        '-e',
        'if exists window 1 then set winTitle to name of window 1',
        '-e',
        'return name & "\n" & winTitle',
        '-e',
        'end tell',
        '-e',
        'end tell',
        '-e',
        'end run',
        targetApp,
      ]));
      const text = stdout.trim();
      const [appName, ...titleParts] = text.split('\n');
      if (sameAppName(appName || '', targetApp) && titleParts.length === 0) {
        return {
          appName: null,
          windowTitle: null,
        };
      }
      return {
        appName: appName || targetApp,
        windowTitle: titleParts.join('\n') || null,
      };
    } catch {
      return {
        appName: targetApp,
        windowTitle: null,
      };
    }
  }
}

const BACKGROUND_AX_ACTION_SCRIPT = [
  'on run argv',
  'set targetApp to item 1 of argv',
  'set actionName to item 2 of argv',
  'set targetRole to item 3 of argv',
  'set targetName to item 4 of argv',
  'set inputText to item 5 of argv',
  'set exactMatch to item 6 of argv',
  'set targetAxPath to item 7 of argv',
  'tell application "System Events"',
  'if not (exists application process targetApp) then error "Target app is not running: " & targetApp',
  'tell application process targetApp',
  'if exists window 1 then',
  'set rootElement to window 1',
  'else',
  'set rootElement to it',
  'end if',
  'if targetAxPath is not "" then',
  'set targetElement to my elementAtPath(rootElement, targetAxPath)',
  'else',
  'set targetElement to my findElement(rootElement, targetRole, targetName, exactMatch)',
  'end if',
  'if targetElement is missing value then error "Target element not found"',
  'if actionName is "type" then',
  'my setElementValue(targetElement, inputText)',
  'return "Background type completed: " & targetApp',
  'else',
  'perform action "AXPress" of targetElement',
  'if actionName is "doubleClick" then perform action "AXPress" of targetElement',
  'return "Background " & actionName & " completed: " & targetApp',
  'end if',
  'end tell',
  'end tell',
  'end run',
  'on findElement(theElement, targetRole, targetName, exactMatch)',
  'tell application "System Events"',
  'set elementRole to my safeRole(theElement)',
  'set elementLabel to my safeLabel(theElement)',
  'if my roleMatches(elementRole, targetRole) and my labelMatches(elementLabel, targetName, exactMatch) then return theElement',
  'try',
  'repeat with childElement in UI elements of theElement',
  'set foundChild to my findElement(childElement, targetRole, targetName, exactMatch)',
  'if foundChild is not missing value then return foundChild',
  'end repeat',
  'end try',
  'end tell',
  'return missing value',
  'end findElement',
  'on elementAtPath(rootElement, targetAxPath)',
  'tell application "System Events"',
  'set currentElement to rootElement',
  'set pathItems to my splitText(targetAxPath, ".")',
  'repeat with pathItem in pathItems',
  'try',
  'set pathIndex to (contents of pathItem) as integer',
  'if pathIndex is less than 1 then return missing value',
  'set childElements to UI elements of currentElement',
  'if pathIndex is greater than (count of childElements) then return missing value',
  'set currentElement to item pathIndex of childElements',
  'on error',
  'return missing value',
  'end try',
  'end repeat',
  'return currentElement',
  'end tell',
  'end elementAtPath',
  'on splitText(sourceText, delimiterText)',
  'set oldDelimiters to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to delimiterText',
  'set textItems to text items of sourceText',
  'set AppleScript\'s text item delimiters to oldDelimiters',
  'return textItems',
  'end splitText',
  'on safeRole(theElement)',
  'tell application "System Events"',
  'try',
  'return role of theElement as text',
  'on error',
  'return ""',
  'end try',
  'end tell',
  'end safeRole',
  'on safeLabel(theElement)',
  'tell application "System Events"',
  'set labels to ""',
  'try',
  'set labelPart to name of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to description of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXTitle" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXDescription" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'return labels',
  'end tell',
  'end safeLabel',
  'on roleMatches(elementRole, targetRole)',
  'if targetRole is "" then return true',
  'if elementRole is targetRole then return true',
  'if targetRole is "button" and elementRole contains "Button" then return true',
  'if targetRole is "textbox" and (elementRole contains "TextField" or elementRole contains "TextArea" or elementRole contains "text") then return true',
  'if targetRole is "checkbox" and elementRole contains "CheckBox" then return true',
  'if targetRole is "radio" and elementRole contains "RadioButton" then return true',
  'if targetRole is "combobox" and elementRole contains "ComboBox" then return true',
  'if targetRole is "menuitem" and elementRole contains "MenuItem" then return true',
  'if targetRole is "tab" and elementRole contains "Tab" then return true',
  'if targetRole is "link" and elementRole contains "Link" then return true',
  'return elementRole contains targetRole',
  'end roleMatches',
  'on labelMatches(elementLabel, targetName, exactMatch)',
  'if targetName is "" then return true',
  'if exactMatch is "true" then return elementLabel is targetName',
  'return elementLabel contains targetName',
  'end labelMatches',
  'on setElementValue(theElement, inputText)',
  'tell application "System Events"',
  'try',
  'set value of theElement to inputText',
  'return',
  'end try',
  'try',
  'set value of attribute "AXValue" of theElement to inputText',
  'return',
  'end try',
  'error "Target element does not accept AXValue"',
  'end tell',
  'end setElementValue',
];

const BACKGROUND_AX_ELEMENTS_SCRIPT = [
  'property outputLines : {}',
  'property itemCount : 0',
  'property maxItems : 40',
  'property maxDepthLimit : 4',
  'on run argv',
  'set outputLines to {}',
  'set itemCount to 0',
  'set targetApp to item 1 of argv',
  'set maxItems to item 2 of argv as integer',
  'set maxDepthLimit to item 3 of argv as integer',
  'tell application "System Events"',
  'if not (exists application process targetApp) then error "Target app is not running: " & targetApp',
  'tell application process targetApp',
  'if exists window 1 then',
  'set rootElement to window 1',
  'else',
  'set rootElement to it',
  'end if',
  'my collectElements(rootElement, 0, "")',
  'end tell',
  'end tell',
  'set oldDelimiters to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to linefeed',
  'set resultText to outputLines as text',
  'set AppleScript\'s text item delimiters to oldDelimiters',
  'return resultText',
  'end run',
  'on collectElements(theElement, currentDepth, currentPath)',
  'if itemCount is greater than or equal to maxItems then return',
  'tell application "System Events"',
  'set elementRole to my safeRole(theElement)',
  'set elementLabel to my compactLabel(my safeLabel(theElement))',
  'if my isInterestingRole(elementRole) and elementLabel is not "" then',
  'set itemCount to itemCount + 1',
  'set end of outputLines to (itemCount as text) & tab & elementRole & tab & elementLabel & tab & currentPath',
  'end if',
  'if currentDepth is greater than or equal to maxDepthLimit then return',
  'try',
  'set childIndex to 0',
  'repeat with childElement in UI elements of theElement',
  'set childIndex to childIndex + 1',
  'if currentPath is "" then',
  'set childPath to childIndex as text',
  'else',
  'set childPath to currentPath & "." & (childIndex as text)',
  'end if',
  'my collectElements(childElement, currentDepth + 1, childPath)',
  'if itemCount is greater than or equal to maxItems then exit repeat',
  'end repeat',
  'end try',
  'end tell',
  'end collectElements',
  'on isInterestingRole(elementRole)',
  'if elementRole contains "Button" then return true',
  'if elementRole contains "CheckBox" then return true',
  'if elementRole contains "RadioButton" then return true',
  'if elementRole contains "TextField" then return true',
  'if elementRole contains "TextArea" then return true',
  'if elementRole contains "ComboBox" then return true',
  'if elementRole contains "PopUpButton" then return true',
  'if elementRole contains "MenuButton" then return true',
  'if elementRole contains "MenuItem" then return true',
  'if elementRole contains "Tab" then return true',
  'if elementRole contains "Link" then return true',
  'return false',
  'end isInterestingRole',
  'on safeRole(theElement)',
  'tell application "System Events"',
  'try',
  'return role of theElement as text',
  'on error',
  'return ""',
  'end try',
  'end tell',
  'end safeRole',
  'on safeLabel(theElement)',
  'tell application "System Events"',
  'set labels to ""',
  'try',
  'set labelPart to name of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to description of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXTitle" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'try',
  'set labelPart to value of attribute "AXDescription" of theElement',
  'if labelPart is not missing value then set labels to labels & " " & (labelPart as text)',
  'end try',
  'return labels',
  'end tell',
  'end safeLabel',
  'on compactLabel(rawLabel)',
  'set cleaned to my replaceText(rawLabel, tab, " ")',
  'set cleaned to my replaceText(cleaned, linefeed, " ")',
  'set cleaned to my replaceText(cleaned, return, " ")',
  'repeat while cleaned contains "  "',
  'set cleaned to my replaceText(cleaned, "  ", " ")',
  'end repeat',
  'if length of cleaned is greater than 80 then set cleaned to text 1 thru 80 of cleaned',
  'return cleaned',
  'end compactLabel',
  'on replaceText(sourceText, searchText, replacementText)',
  'set oldDelimiters to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to searchText',
  'set textItems to text items of sourceText',
  'set AppleScript\'s text item delimiters to replacementText',
  'set replacedText to textItems as text',
  'set AppleScript\'s text item delimiters to oldDelimiters',
  'return replacedText',
  'end replaceText',
];

const computerSurface = new DesktopComputerSurface();

export function getComputerSurface(): DesktopComputerSurface {
  return computerSurface;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const items = (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
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

function sameAppName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeBackgroundAction(action: string): string {
  return action === 'doubleClick' ? 'doubleClick' : action;
}

function normalizeBackgroundRole(role: string | undefined): string {
  if (!role) return '';
  if (role === 'textfield') return 'textbox';
  return role;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

type BackgroundAxElement = { index: number; role: string; name: string; axPath: string };

function parseBackgroundElementLines(stdout: string): BackgroundAxElement[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [indexText, role = '', name = '', axPath = ''] = line.split('\t');
      const index = Number.parseInt(indexText, 10);
      return {
        index: Number.isFinite(index) ? index : 0,
        role: role.trim(),
        name: name.trim(),
        axPath: axPath.trim(),
      };
    })
    .filter((element) => element.index > 0 && element.role);
}

function assessAxTreeQuality(elements: BackgroundAxElement[], reachedLimit: boolean): ComputerSurfaceAxQuality {
  const elementCount = elements.length;
  const labeledElementCount = elements.filter((element) => element.name.trim().length > 0).length;
  const withAxPathCount = elements.filter((element) => element.axPath.trim().length > 0).length;
  const unlabeledRatio = elementCount > 0 ? 1 - labeledElementCount / elementCount : 1;
  const missingAxPathRatio = elementCount > 0 ? 1 - withAxPathCount / elementCount : 1;
  const roleCounts: Record<string, number> = {};
  const labelRoleCounts = new Map<string, number>();
  for (const element of elements) {
    const role = element.role || 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    const labelKey = `${role}:${element.name.trim().toLowerCase()}`;
    if (element.name.trim()) {
      labelRoleCounts.set(labelKey, (labelRoleCounts.get(labelKey) || 0) + 1);
    }
  }

  const duplicateLabelRoleCount = [...labelRoleCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  const reasons: string[] = [];
  let score = 1;

  if (elementCount === 0) {
    reasons.push('no interactive AX elements returned');
    score = 0;
  } else {
    if (elementCount < 3) {
      reasons.push(`only ${elementCount} interactive AX element${elementCount === 1 ? '' : 's'} returned`);
      score -= 0.25;
    }
    if (unlabeledRatio > 0.35) {
      reasons.push(`${Math.round(unlabeledRatio * 100)}% of candidates are unlabeled`);
      score -= 0.3;
    } else if (unlabeledRatio > 0.1) {
      reasons.push(`${Math.round(unlabeledRatio * 100)}% of candidates are unlabeled`);
      score -= 0.1;
    }
    if (missingAxPathRatio > 0.2) {
      reasons.push(`${Math.round(missingAxPathRatio * 100)}% of candidates lack axPath`);
      score -= 0.2;
    }
    if (duplicateLabelRoleCount > 0) {
      reasons.push(`${duplicateLabelRoleCount} candidates share the same role/name`);
      score -= Math.min(0.25, duplicateLabelRoleCount / Math.max(1, elementCount));
    }
    if (reachedLimit) {
      reasons.push('candidate listing reached the requested limit');
      score -= 0.1;
    }
  }

  const clampedScore = Math.max(0, Math.min(1, score));
  const roundedScore = Math.round(clampedScore * 100) / 100;
  const grade: ComputerSurfaceAxQuality['grade'] = roundedScore >= 0.75
    ? 'good'
    : roundedScore >= 0.45
      ? 'usable'
      : 'poor';

  return {
    score: roundedScore,
    grade,
    elementCount,
    labeledElementCount,
    withAxPathCount,
    unlabeledRatio: Math.round(unlabeledRatio * 100) / 100,
    missingAxPathRatio: Math.round(missingAxPathRatio * 100) / 100,
    duplicateLabelRoleCount,
    roleCounts,
    reasons: reasons.length > 0 ? reasons : ['AX tree has enough labeled, addressable candidates'],
  };
}

function formatAxQualityLine(quality: ComputerSurfaceAxQuality): string {
  return `AX quality: ${quality.grade} score=${quality.score} (${quality.reasons.join('; ')})`;
}

function formatBackgroundCgEventWindowLine(window: BackgroundCgEventWindow): string {
  const title = window.title ? ` "${window.title}"` : '';
  const quality = typeof window.qualityScore === 'number'
    ? `quality=${window.qualityGrade || 'unknown'}:${window.qualityScore}`
    : null;
  const ref = window.windowRef ? `windowRef=${window.windowRef}` : null;
  const recommended = window.recommended ? 'recommended=yes' : null;
  return [
    `${window.appName}${title}`,
    window.bundleId ? `bundleId=${window.bundleId}` : null,
    `pid=${window.pid}`,
    `windowId=${window.windowId}`,
    `bounds=${formatBounds(window.bounds)}`,
    quality,
    ref,
    recommended,
  ].filter(Boolean).join(' · ');
}

function formatBounds(bounds: BackgroundCgEventWindowBounds): string {
  return `${roundPoint(bounds.x)},${roundPoint(bounds.y)} ${roundPoint(bounds.width)}x${roundPoint(bounds.height)}`;
}

function formatTargetSuffix(options: ListBackgroundCgEventWindowsOptions): string {
  const parts = [
    options.targetApp ? `targetApp=${options.targetApp}` : null,
    options.bundleId ? `bundleId=${options.bundleId}` : null,
    options.title ? `title="${options.title}"` : null,
    options.pid ? `pid=${options.pid}` : null,
    options.windowId ? `windowId=${options.windowId}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` for ${parts.join(' · ')}` : '';
}

function formatAppDiagnosis(diagnosis: BackgroundCgEventAppDiagnosis): string {
  return [
    `Computer Surface diagnosis${diagnosis.targetApp ? ` for ${diagnosis.targetApp}` : ''}`,
    `Platform: ${diagnosis.platform}${diagnosis.os.version ? ` · ${diagnosis.os.version}` : ''}`,
    `Helper: ${diagnosis.helper.available ? 'available' : 'unavailable'}${diagnosis.helper.path ? ` · ${diagnosis.helper.path}` : ''}`,
    `TCC: Accessibility=${diagnosis.permissions.accessibilityTrusted === true ? 'granted' : diagnosis.permissions.accessibilityTrusted === false ? 'missing' : 'unknown'} · ScreenRecording=${diagnosis.permissions.screenRecordingGranted === true ? 'granted' : diagnosis.permissions.screenRecordingGranted === false ? 'missing' : 'unknown'}`,
    `CGEventSetWindowLocation: ${diagnosis.symbols.cgEventSetWindowLocationAvailable === true ? 'available' : diagnosis.symbols.cgEventSetWindowLocationAvailable === false ? 'unavailable' : 'unknown'}`,
    `Processes: ${diagnosis.processes.length ? diagnosis.processes.map((process) => `${process.appName} pid=${process.pid}${process.bundleId ? ` bundleId=${process.bundleId}` : ''}${process.isActive ? ' active=yes' : ''}`).join('; ') : 'none'}`,
    `AX suitability: ${diagnosis.ax.suitable ? 'yes' : 'no'} · ${diagnosis.ax.reasons.join('; ')}`,
    `CGEvent suitability: ${diagnosis.cgEvent.suitable ? 'yes' : 'no'} · ${diagnosis.cgEvent.reasons.join('; ')}`,
    diagnosis.recommendedWindow ? `Recommended window: ${formatBackgroundCgEventWindowLine(diagnosis.recommendedWindow)}` : 'Recommended window: none',
    diagnosis.windows.length > 0
      ? [
          `Window candidates: ${diagnosis.windows.length}`,
          ...diagnosis.windows.slice(0, 8).map(formatBackgroundCgEventWindowLine),
        ].join('\n')
      : 'Window candidates: none',
  ].join('\n');
}

function backgroundCgEventMetadata(result: BackgroundCgEventClickResult): Record<string, unknown> {
  return {
    backgroundSurface: true,
    computerSurfaceMode: 'background_cgevent',
    targetApp: result.appName,
    targetBundleId: result.bundleId || null,
    targetPid: result.pid,
    targetWindowId: result.windowId,
    targetWindowRef: result.windowRef || null,
    targetWindowTitle: result.title || null,
    targetWindowBounds: result.bounds,
    windowLocalPoint: result.windowLocalPoint,
    screenPoint: result.screenPoint,
    button: result.button,
    clickCount: result.clickCount,
    isTargetActive: result.isTargetActive,
    usedWindowLocation: result.usedWindowLocation,
    eventNumbers: result.eventNumbers || [],
    targetVerification: result.targetVerification || null,
    evidenceSummary: [
      `pid=${result.pid} windowId=${result.windowId}${result.windowRef ? ` windowRef=${result.windowRef}` : ''}`,
      `bounds=${formatBounds(result.bounds)}`,
      `windowLocal=${roundPoint(result.windowLocalPoint.x)},${roundPoint(result.windowLocalPoint.y)} screen=${roundPoint(result.screenPoint.x)},${roundPoint(result.screenPoint.y)}`,
      `active=${result.isTargetActive ? 'yes' : 'no'} usedWindowLocation=${result.usedWindowLocation ? 'yes' : 'no'}`,
      `button=${result.button} clickCount=${result.clickCount}${result.eventNumbers?.length ? ` eventNumbers=${result.eventNumbers.join(',')}` : ''}`,
      result.targetVerification?.warnings.length
        ? `verification warnings=${result.targetVerification.warnings.join('; ')}`
        : null,
    ].filter(Boolean),
  };
}

function normalizeBackgroundCgEventRequest(action: ComputerSurfaceAction): {
  pid: number;
  windowId: number;
  windowRef?: string;
  targetApp?: string;
  bundleId?: string;
  title?: string;
  windowLocalPoint: BackgroundCgEventWindowPoint;
  button: 'left' | 'right';
  clickCount: number;
  timeoutMs?: number;
} | null {
  const point = getWindowLocalPoint(action);
  const parsedRef = parseWindowRef(action.windowRef);
  const pid = action.pid ?? parsedRef?.pid;
  const windowId = action.windowId ?? parsedRef?.windowId;
  if (
    !isPositiveFiniteNumber(pid)
    || !isPositiveFiniteNumber(windowId)
    || !point
  ) {
    return null;
  }
  return {
    pid: Math.trunc(pid),
    windowId: Math.trunc(windowId),
    windowRef: action.windowRef,
    targetApp: action.targetApp,
    bundleId: action.bundleId,
    title: action.title,
    windowLocalPoint: point,
    button: action.button === 'right' || action.action === 'rightClick' ? 'right' : 'left',
    clickCount: action.action === 'doubleClick'
      ? 2
      : Math.max(1, Math.min(2, Math.trunc(action.clickCount || 1))),
    timeoutMs: action.timeout,
  };
}

function parseWindowRef(windowRef: string | undefined): { pid: number; windowId: number } | null {
  if (!windowRef) return null;
  const match = /^cgwin:(\d+):(\d+):[a-f0-9]{12}$/i.exec(windowRef.trim());
  if (!match) return null;
  return {
    pid: Number.parseInt(match[1], 10),
    windowId: Number.parseInt(match[2], 10),
  };
}

function getWindowLocalPoint(action: ComputerSurfaceAction): BackgroundCgEventWindowPoint | null {
  if (
    action.windowLocalPoint
    && Number.isFinite(action.windowLocalPoint.x)
    && Number.isFinite(action.windowLocalPoint.y)
  ) {
    return action.windowLocalPoint;
  }
  if (Number.isFinite(action.windowX) && Number.isFinite(action.windowY)) {
    return {
      x: action.windowX as number,
      y: action.windowY as number,
    };
  }
  return null;
}

function parseWindowLocalPointFromParams(params: Record<string, unknown>): BackgroundCgEventWindowPoint | null {
  const action = params as unknown as ComputerSurfaceAction;
  return getWindowLocalPoint(action);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function roundPoint(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function toAppleScriptArgs(lines: string[]): string[] {
  return lines.flatMap((line) => ['-e', line]);
}

function getExecStdout(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (Buffer.isBuffer(result)) {
    return result.toString('utf8');
  }
  if (result && typeof result === 'object' && 'stdout' in result) {
    const stdout = (result as { stdout?: string | Buffer }).stdout;
    return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout || '';
  }
  return '';
}

function formatExecError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, ' ').trim();
  }
  return 'Unknown error';
}

function isLikelyAccessibilityPermissionError(message: string): boolean {
  return /not authorized|not permitted|operation not permitted|assistive access|accessibility|privacy|tcc/i.test(message);
}

function isSensitiveAction(action: ComputerSurfaceAction): boolean {
  const content = [action.text, action.key, action.name, action.selector, action.role]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /password|passcode|token|secret|credit card|cvv|payment|pay now|transfer|wire|delete account|admin|sudo/.test(content);
}

function redactAction(action: ComputerSurfaceAction): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (/password|token|secret|credential|cookie/i.test(key)) {
      redacted[key] = '[redacted]';
    } else if (key === 'text' && typeof value === 'string') {
      redacted[key] = `[redacted ${value.length} chars]`;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
