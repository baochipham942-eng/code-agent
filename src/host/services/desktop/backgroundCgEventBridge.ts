import type {
  BackgroundCgEventAppDiagnosis,
  BackgroundCgEventClickResult,
  BackgroundCgEventWindow,
  BackgroundCgEventWindowBounds,
  BackgroundCgEventWindowPoint,
  ListBackgroundCgEventWindowsOptions,
} from './backgroundCgEventSurface';
import type { ComputerSurfaceAction } from './computerSurface';

export function sameAppName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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

export function formatBounds(bounds: BackgroundCgEventWindowBounds): string {
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

export function formatWindowObservationOutput(args: {
  windows: BackgroundCgEventWindow[];
  targetMatches: BackgroundCgEventWindow[];
  visibleWindows: BackgroundCgEventWindow[];
  options: ListBackgroundCgEventWindowsOptions;
  recommendedWindow: BackgroundCgEventWindow | null;
}): string {
  const { windows, targetMatches, visibleWindows, options, recommendedWindow } = args;
  const header = windows.length > 0
    ? `Found ${windows.length} background CGEvent window candidates${formatTargetSuffix(options)}.`
    : `No background CGEvent window candidates found${formatTargetSuffix(options)}.`;
  return [
    header,
    formatTargetMatchesLine(targetMatches, options),
    recommendedWindow
      ? `Recommended window: ${formatBackgroundCgEventWindowLine(recommendedWindow)}`
      : 'Recommended window: none',
    `Visible apps: ${formatVisibleAppSummary(visibleWindows)}`,
    windows.length > 0 ? 'Window candidates:' : null,
    ...windows.map(formatBackgroundCgEventWindowLine),
  ].filter(Boolean).join('\n');
}

function formatTargetMatchesLine(
  targetMatches: BackgroundCgEventWindow[],
  options: ListBackgroundCgEventWindowsOptions,
): string {
  if (!hasWindowTargetIntent(options)) {
    return 'Target matches: no target filter provided';
  }
  if (targetMatches.length === 0) {
    return `Target matches: 0${formatTargetSuffix(options)}`;
  }
  const preview = targetMatches
    .slice(0, 4)
    .map(formatWindowShortRef)
    .join('; ');
  const remainder = targetMatches.length > 4 ? `; +${targetMatches.length - 4} more` : '';
  return `Target matches: ${targetMatches.length}${formatTargetSuffix(options)} -> ${preview}${remainder}`;
}

export function formatVisibleAppSummary(windows: BackgroundCgEventWindow[]): string {
  if (windows.length === 0) {
    return 'none';
  }
  const groups = new Map<string, {
    appName: string;
    bundleId: string | null;
    count: number;
  }>();
  for (const window of windows) {
    const appName = window.appName || 'unknown';
    const bundleId = window.bundleId || null;
    const key = `${appName}\u0000${bundleId || ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { appName, bundleId, count: 1 });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.appName.localeCompare(b.appName))
    .slice(0, 8)
    .map((group) => `${group.appName}${group.bundleId ? `/${group.bundleId}` : ''} x${group.count}`)
    .join('; ');
}

function formatWindowShortRef(window: BackgroundCgEventWindow): string {
  return [
    `${window.appName}${window.bundleId ? `/${window.bundleId}` : ''}`,
    window.title ? `"${window.title}"` : null,
    `pid=${window.pid}`,
    `windowId=${window.windowId}`,
  ].filter(Boolean).join(' ');
}

export function getWindowResultLimit(options: ListBackgroundCgEventWindowsOptions): number {
  return typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(200, Math.trunc(options.limit)))
    : 80;
}

export function hasWindowTargetIntent(options: ListBackgroundCgEventWindowsOptions): boolean {
  return Boolean(
    options.targetApp
      || options.bundleId
      || options.title
      || typeof options.pid === 'number'
      || typeof options.windowId === 'number',
  );
}

export function getWindowTargetMatches(
  windows: BackgroundCgEventWindow[],
  options: ListBackgroundCgEventWindowsOptions,
): BackgroundCgEventWindow[] {
  if (!hasWindowTargetIntent(options)) {
    return [];
  }
  return windows.filter((window) => matchesWindowTargetIntent(window, options));
}

function matchesWindowTargetIntent(
  window: BackgroundCgEventWindow,
  options: ListBackgroundCgEventWindowsOptions,
): boolean {
  if (options.targetApp && !matchesWindowTextTarget(
    [window.appName, window.bundleId, window.title],
    options.targetApp,
  )) {
    return false;
  }
  if (options.bundleId && !matchesWindowTextTarget([window.bundleId], options.bundleId)) {
    return false;
  }
  if (options.title && !matchesWindowTextTarget([window.title], options.title)) {
    return false;
  }
  if (typeof options.pid === 'number' && window.pid !== Math.trunc(options.pid)) {
    return false;
  }
  if (typeof options.windowId === 'number' && window.windowId !== Math.trunc(options.windowId)) {
    return false;
  }
  return true;
}

function matchesWindowTextTarget(candidates: Array<string | null | undefined>, target: string): boolean {
  const terms = expandWindowTargetTerms(target);
  if (terms.length === 0) {
    return false;
  }
  return candidates.some((candidate) => {
    const normalized = normalizeWindowTargetText(candidate);
    if (!normalized) {
      return false;
    }
    return terms.some((term) =>
      normalized === term
        || (term.length >= 4 && normalized.includes(term))
        || (normalized.length >= 4 && term.includes(normalized)),
    );
  });
}

function expandWindowTargetTerms(target: string): string[] {
  const normalized = normalizeWindowTargetText(target);
  const terms = new Set<string>();
  if (normalized) {
    terms.add(normalized);
  }
  if (
    normalized.includes('tencentmeeting')
    || normalized.includes('comtencentmeeting')
    || target.includes('腾讯会议')
  ) {
    terms.add('tencentmeeting');
    terms.add('comtencentmeeting');
    terms.add('腾讯会议');
  }
  return Array.from(terms);
}

function normalizeWindowTargetText(value: string | null | undefined): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, '');
}

export function formatAppDiagnosis(diagnosis: BackgroundCgEventAppDiagnosis): string {
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

export function backgroundCgEventMetadata(result: BackgroundCgEventClickResult): Record<string, unknown> {
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

export function normalizeBackgroundCgEventRequest(action: ComputerSurfaceAction): {
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

export function parseWindowLocalPointFromParams(params: Record<string, unknown>): BackgroundCgEventWindowPoint | null {
  const action = params as unknown as ComputerSurfaceAction;
  return getWindowLocalPoint(action);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function roundPoint(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function getExecStdout(result: unknown): string {
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

export function formatExecError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, ' ').trim();
  }
  return 'Unknown error';
}

export function isLikelyAccessibilityPermissionError(message: string): boolean {
  return /not authorized|not permitted|operation not permitted|assistive access|accessibility|privacy|tcc/i.test(message);
}
