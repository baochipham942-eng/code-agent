import type { ToolExecutionResult } from '../types';
import type {
  ComputerSurfaceAxQuality,
  ComputerSurfaceFailureKind,
  ComputerSurfaceState,
  WorkbenchActionTrace,
} from '../../../shared/contract/desktop';
import type { getComputerSurface } from '../../services/desktop/computerSurface';
import type { ComputerAction } from './computerUse';
import { isSmartAction } from './computerUseSmartBrowserActions';
import { isFiniteNumber } from './computerUseGuards';

type ComputerSurfaceFacade = ReturnType<typeof getComputerSurface>;

export function withComputerSurfaceMetadata(
  result: ToolExecutionResult,
  args: {
    state: ComputerSurfaceState;
    trace: WorkbenchActionTrace;
    sensitive: boolean;
  },
): ToolExecutionResult {
  const withMetadata: ToolExecutionResult = {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      computerSurface: args.state,
      computerSurfaceMode: args.state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(args.state.mode),
      foregroundFallback: args.state.mode === 'foreground_fallback',
      background: args.state.background,
      requiresForeground: args.state.requiresForeground,
      approvalScope: args.state.approvalScope,
      safetyNote: args.state.safetyNote,
      targetApp: args.state.targetApp || null,
      sensitiveAction: args.sensitive,
      traceId: args.trace.id,
      workbenchTrace: args.trace,
      failureKind: args.trace.failureKind || args.state.failureKind || (!result.success ? 'action_execution_failed' : null),
      blockingReasons: args.trace.blockingReasons || args.state.blockingReasons || (!result.success && result.error ? [result.error] : undefined),
      recommendedAction: args.trace.recommendedAction || args.state.recommendedAction || null,
      evidenceSummary: args.trace.evidenceSummary || args.state.evidenceSummary || result.metadata?.evidenceSummary,
      axQuality: args.trace.axQuality || args.state.axQuality || null,
    },
  };

  return attachDesktopPostActionContract(withMetadata);
}

export function isBackgroundComputerSurfaceMode(mode: ComputerSurfaceState['mode']): boolean {
  return mode === 'background_ax' || mode === 'background_cgevent';
}

function attachDesktopPostActionContract(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.success) {
    return result;
  }

  const contract = {
    reobserveRequired: true,
    reason: 'Run computer_use.observe or get_state before claiming the final desktop UI state.',
  };
  const outputLine = `Post-action contract: ${contract.reason}`;

  return {
    ...result,
    output: result.output ? `${result.output}\n${outputLine}` : outputLine,
    metadata: {
      ...(result.metadata || {}),
      desktopActionContract: contract,
    },
  };
}

export function buildComputerSurfacePreflightBlockedResult(
  action: ComputerAction,
  computerSurface: ComputerSurfaceFacade,
): ToolExecutionResult | null {
  if (!shouldBlockMissingDesktopLocator(action)) {
    return null;
  }

  const blockingReasons = [
    'Background Accessibility action needs axPath, selector, or role plus name for a stable target locator.',
  ];
  const recommendedAction = 'Run computer_use.get_ax_elements for the target app and retry with the returned axPath.';
  const trace: WorkbenchActionTrace = {
    id: `computer_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    targetKind: 'computer',
    toolName: 'computer_use',
    action: action.action,
    mode: 'background_ax',
    startedAtMs: Date.now(),
    params: redactComputerActionParams(action),
    success: false,
    error: blockingReasons[0],
    failureKind: 'locator_missing',
    blockingReasons,
    recommendedAction,
  };
  const state = computerSurface.getState({
    targetApp: action.targetApp || undefined,
    blockedReason: blockingReasons[0],
    approvalScope: 'blocked',
    mode: 'background_ax',
    failureKind: 'locator_missing',
    blockingReasons,
    recommendedAction,
  });

  return {
    success: false,
    error: blockingReasons[0],
    metadata: {
      code: 'COMPUTER_SURFACE_BLOCKED',
      workbenchBlocked: true,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: true,
      foregroundFallback: false,
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: action.targetApp || null,
      sensitiveAction: false,
      traceId: trace.id,
      workbenchTrace: trace,
      failureKind: 'locator_missing',
      blockingReasons,
      recommendedAction,
    },
  };
}

function shouldBlockMissingDesktopLocator(action: ComputerAction): boolean {
  if (isSmartAction(action.action) || isSurfaceReadAction(action.action)) {
    return false;
  }
  if (!action.targetApp || !['click', 'doubleClick'].includes(action.action)) {
    return false;
  }
  if (isFiniteNumber(action.x) && isFiniteNumber(action.y)) {
    return false;
  }
  if (hasBackgroundCgEventLocator(action)) {
    return false;
  }
  return !hasDesktopElementLocator(action);
}

function hasDesktopElementLocator(action: ComputerAction): boolean {
  return Boolean(action.axPath || action.selector || (action.role && action.name));
}

function hasBackgroundCgEventLocator(action: ComputerAction): boolean {
  const hasWindowIdentity = (isFiniteNumber(action.pid) && isFiniteNumber(action.windowId))
    || isValidWindowRef(action.windowRef);
  const hasWindowPoint = Boolean(
    (action.windowLocalPoint && isFiniteNumber(action.windowLocalPoint.x) && isFiniteNumber(action.windowLocalPoint.y))
    || (isFiniteNumber(action.windowX) && isFiniteNumber(action.windowY)),
  );
  return hasWindowIdentity && hasWindowPoint;
}

function isValidWindowRef(value: unknown): value is string {
  return typeof value === 'string' && /^cgwin:\d+:\d+:[a-f0-9]{12}$/i.test(value);
}

export function classifyComputerSurfaceActionFailure(
  error: string,
  mode: ComputerSurfaceState['mode'],
): ComputerSurfaceFailureKind {
  const message = error.toLowerCase();
  if (/not authorized|not permitted|operation not permitted|assistive access|accessibility|privacy|tcc/.test(message)) {
    return 'permission_denied';
  }
  if (/target app is not running|application isn't running|app is not running/.test(message)) {
    return 'target_app_not_running';
  }
  if (/target window verification failed|stale|not visible now|target window not found|window not found|windowref|windowid|window id/.test(message)) {
    return 'target_window_not_found';
  }
  if (/target element not found|element not found|no matching element|could not find/.test(message)) {
    return 'locator_missing';
  }
  if (/multiple matches|ambiguous|more than one/.test(message)) {
    return 'locator_ambiguous';
  }
  if (/coordinate|screen point|invalid index|outside/.test(message)) {
    return 'coordinate_untrusted';
  }
  return mode === 'background_ax' && /ax|accessibility|ui element/.test(message)
    ? 'ax_unavailable'
    : 'action_execution_failed';
}

function getComputerSurfaceReliabilityFromMetadata(
  metadata: Record<string, unknown>,
  result?: ToolExecutionResult,
  mode: ComputerSurfaceState['mode'] = 'background_ax',
): {
  failureKind: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction: string | null;
  axQuality: ComputerSurfaceAxQuality | null;
} {
  const failureKind = isComputerSurfaceFailureKind(metadata.failureKind)
    ? metadata.failureKind
    : !result?.success && result?.error
      ? classifyComputerSurfaceActionFailure(result.error, mode)
      : null;
  const blockingReasons = Array.isArray(metadata.blockingReasons)
    ? metadata.blockingReasons.filter((item): item is string => typeof item === 'string')
    : undefined;
  const recommendedAction = typeof metadata.recommendedAction === 'string'
    ? metadata.recommendedAction
    : null;
  const axQuality = isComputerSurfaceAxQuality(metadata.axQuality)
    ? metadata.axQuality
    : null;
  return {
    failureKind,
    blockingReasons,
    recommendedAction,
    axQuality,
  };
}

function isComputerSurfaceFailureKind(value: unknown): value is ComputerSurfaceFailureKind {
  return typeof value === 'string' && [
    'permission_denied',
    'target_app_not_running',
    'target_not_frontmost',
    'target_window_not_found',
    'ax_unavailable',
    'ax_tree_poor',
    'locator_missing',
    'locator_ambiguous',
    'coordinate_untrusted',
    'action_execution_failed',
    'evidence_unavailable',
  ].includes(value);
}

function isComputerSurfaceAxQuality(value: unknown): value is ComputerSurfaceAxQuality {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.score === 'number'
    && ['good', 'usable', 'poor'].includes(String(record.grade))
    && typeof record.elementCount === 'number'
    && Array.isArray(record.reasons);
}

function redactComputerActionParams(action: ComputerAction): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    redacted[key] = key === 'text' && typeof value === 'string'
      ? `[redacted ${value.length} chars]`
      : value;
  }
  return redacted;
}

export function getEvidenceSummaryFromMetadata(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const value = metadata?.evidenceSummary;
  if (!Array.isArray(value)) return undefined;
  const summary = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return summary.length > 0 ? summary : undefined;
}

function getResultTargetApp(metadata: Record<string, unknown>, fallback?: string): string | null {
  if (metadata.targetApp === null) {
    return null;
  }
  if (typeof metadata.targetApp === 'string') {
    return metadata.targetApp;
  }
  return fallback || null;
}

export function isSurfaceReadAction(action: string): boolean {
  return action === 'get_state'
    || action === 'observe'
    || action === 'get_ax_elements'
    || action === 'get_windows'
    || action === 'diagnose_app';
}

export async function executeSurfaceReadAction(
  computerSurface: ComputerSurfaceFacade,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  if (action.action === 'observe') {
    return observeComputerSurface(computerSurface, action);
  }

  if (action.action === 'get_ax_elements') {
    return listComputerSurfaceElements(computerSurface, action);
  }

  if (action.action === 'get_windows') {
    return listComputerSurfaceWindows(computerSurface, action);
  }

  if (action.action === 'diagnose_app') {
    return diagnoseComputerSurfaceApp(computerSurface, action);
  }

  return getComputerSurfaceStateResult(computerSurface.getState({
    targetApp: action.targetApp || undefined,
  }));
}

function getComputerSurfaceStateResult(state: ComputerSurfaceState): ToolExecutionResult {
  return {
    success: true,
    output: formatComputerSurfaceState(state),
    metadata: {
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(state.mode),
      foregroundFallback: state.mode === 'foreground_fallback',
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: state.targetApp || null,
    },
  };
}

async function observeComputerSurface(
  computerSurface: ComputerSurfaceFacade,
  action: Pick<ComputerAction, 'includeScreenshot' | 'targetApp'>,
): Promise<ToolExecutionResult> {
  const snapshot = await computerSurface.observe({
    includeScreenshot: action.includeScreenshot,
    targetApp: action.targetApp,
  });
  const failureKind = snapshot.failureKind || null;
  const blockingReasons = snapshot.blockingReasons;
  const recommendedAction = snapshot.recommendedAction || null;
  const state = computerSurface.getState({
    targetApp: failureKind ? undefined : snapshot.appName || undefined,
    blockedReason: failureKind ? blockingReasons?.join(' ') || 'Computer Surface observe blocked' : null,
    failureKind,
    blockingReasons,
    recommendedAction,
  });
  const label = action.targetApp ? 'Target' : 'Frontmost';
  const targetLine = failureKind
    ? `${label}: protected app blocked`
    : `${label}: ${snapshot.appName || action.targetApp || 'unknown'}${snapshot.windowTitle ? ` · ${snapshot.windowTitle}` : ''}`;
  return {
    success: !failureKind,
    error: failureKind ? blockingReasons?.[0] || 'Computer Surface observe blocked.' : undefined,
    output: [
      formatComputerSurfaceState(state),
      targetLine,
      snapshot.screenshotPath ? `Screenshot: ${snapshot.screenshotPath}` : null,
    ].filter(Boolean).join('\n'),
    metadata: {
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(state.mode),
      foregroundFallback: state.mode === 'foreground_fallback',
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp: state.targetApp || null,
      computerSurfaceSnapshot: snapshot,
      failureKind,
      blockingReasons,
      recommendedAction,
      preserveObservation: true,
      observationKind: 'computer_surface_read',
    },
  };
}

async function listComputerSurfaceElements(
  computerSurface: ComputerSurfaceFacade,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  const result = await computerSurface.listBackgroundElements(action);
  const metadata = result.metadata || {};
  const reliability = getComputerSurfaceReliabilityFromMetadata(metadata, result, 'background_ax');
  const targetApp = getResultTargetApp(metadata, action.targetApp);
  const state = computerSurface.getState({
    targetApp: targetApp || undefined,
    blockedReason: result.success ? null : result.error || null,
    mode: 'background_ax',
    failureKind: reliability.failureKind,
    blockingReasons: reliability.blockingReasons,
    recommendedAction: reliability.recommendedAction,
    axQuality: reliability.axQuality,
  });
  return {
    ...result,
    metadata: {
      ...metadata,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: isBackgroundComputerSurfaceMode(state.mode),
      foregroundFallback: state.mode === 'foreground_fallback',
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp,
      failureKind: reliability.failureKind,
      blockingReasons: reliability.blockingReasons,
      recommendedAction: reliability.recommendedAction,
      axQuality: reliability.axQuality,
      preserveObservation: true,
      observationKind: 'computer_surface_read',
    },
  };
}

async function listComputerSurfaceWindows(
  computerSurface: ComputerSurfaceFacade,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  const result = await computerSurface.listBackgroundCgEventWindows({
    targetApp: action.targetApp,
    bundleId: action.bundleId,
    title: action.title,
    pid: action.pid,
    windowId: action.windowId,
    limit: action.limit,
    timeoutMs: action.timeout,
  });
  const metadata = result.metadata || {};
  const reliability = getComputerSurfaceReliabilityFromMetadata(metadata, result, 'background_cgevent');
  const targetApp = getResultTargetApp(metadata, action.targetApp);
  const state = computerSurface.getState({
    targetApp: targetApp || undefined,
    blockedReason: result.success ? null : result.error || null,
    mode: 'background_cgevent',
    failureKind: reliability.failureKind,
    blockingReasons: reliability.blockingReasons,
    recommendedAction: reliability.recommendedAction,
  });
  return {
    ...result,
    metadata: {
      ...metadata,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: true,
      foregroundFallback: false,
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp,
      failureKind: reliability.failureKind,
      blockingReasons: reliability.blockingReasons,
      recommendedAction: reliability.recommendedAction,
      preserveObservation: true,
      observationKind: 'computer_surface_read',
    },
  };
}

async function diagnoseComputerSurfaceApp(
  computerSurface: ComputerSurfaceFacade,
  action: ComputerAction,
): Promise<ToolExecutionResult> {
  const result = await computerSurface.diagnoseApp(action);
  const metadata = result.metadata || {};
  const reliability = getComputerSurfaceReliabilityFromMetadata(metadata, result, 'background_cgevent');
  const targetApp = getResultTargetApp(metadata, action.targetApp);
  const state = computerSurface.getState({
    targetApp: targetApp || undefined,
    blockedReason: result.success ? null : result.error || null,
    mode: 'background_cgevent',
    failureKind: reliability.failureKind,
    blockingReasons: reliability.blockingReasons,
    recommendedAction: reliability.recommendedAction,
  });
  return {
    ...result,
    metadata: {
      ...metadata,
      computerSurface: state,
      computerSurfaceMode: state.mode,
      backgroundSurface: true,
      foregroundFallback: false,
      background: state.background,
      requiresForeground: state.requiresForeground,
      approvalScope: state.approvalScope,
      safetyNote: state.safetyNote,
      targetApp,
      failureKind: reliability.failureKind,
      blockingReasons: reliability.blockingReasons,
      recommendedAction: reliability.recommendedAction,
      preserveObservation: true,
      observationKind: 'computer_surface_read',
    },
  };
}

function formatComputerSurfaceState(state: ComputerSurfaceState): string {
  const parts = [
    `Computer Surface: ${state.ready ? 'ready' : 'not ready'}`,
    `mode=${state.mode}`,
    `background=${state.background ? 'yes' : 'no'}`,
  ];
  if (state.requiresForeground) {
    parts.push('foreground=current app/window');
  }
  if (state.mode === 'background_ax') {
    parts.push('targeting=macOS Accessibility');
  }
  if (state.mode === 'background_cgevent') {
    parts.push('targeting=macOS CGEvent');
  }
  if (state.approvalScope) {
    parts.push(`approval=${state.approvalScope}`);
  }
  if (state.targetApp) {
    parts.push(`target=${state.targetApp}`);
  }
  if (state.blockedReason) {
    parts.push(`blocked=${state.blockedReason}`);
  }
  if (state.lastAction?.id) {
    parts.push(`lastTrace=${state.lastAction.id}`);
  }
  if (state.axQuality) {
    parts.push(`axQuality=${state.axQuality.grade}:${state.axQuality.score}`);
  }
  if (state.failureKind) {
    parts.push(`failure=${state.failureKind}`);
  }
  return parts.join(' · ');
}
