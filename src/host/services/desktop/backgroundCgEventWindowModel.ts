import { createHash } from 'crypto';
import type {
  BackgroundCgEventAppDiagnosis,
  BackgroundCgEventClickRequest,
  BackgroundCgEventWindow,
  BackgroundCgEventWindowBounds,
  BackgroundCgEventWindowPoint,
  ListBackgroundCgEventWindowsOptions,
} from './backgroundCgEventSurface';

export function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    throw new Error('Background CGEvent helper returned empty output.');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Background CGEvent helper returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`);
  }
}

export function parseWindow(value: unknown): BackgroundCgEventWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const bounds = parseBounds(record.bounds);
  if (
    typeof record.windowId !== 'number'
    || typeof record.pid !== 'number'
    || typeof record.appName !== 'string'
    || !bounds
  ) {
    return null;
  }
  return {
    windowId: record.windowId,
    pid: record.pid,
    appName: record.appName,
    bundleId: typeof record.bundleId === 'string' ? record.bundleId : null,
    title: typeof record.title === 'string' ? record.title : null,
    bounds,
    layer: typeof record.layer === 'number' ? record.layer : null,
    alpha: typeof record.alpha === 'number' ? record.alpha : null,
    isOnScreen: typeof record.isOnScreen === 'boolean' ? record.isOnScreen : null,
  };
}

export function enrichWindow(
  window: BackgroundCgEventWindow | null,
  options: ListBackgroundCgEventWindowsOptions | BackgroundCgEventClickRequest = {},
): BackgroundCgEventWindow | null {
  if (!window) return null;
  const quality = scoreWindowCandidate(window, options);
  return {
    ...window,
    windowRef: createWindowRef(window),
    qualityScore: quality.score,
    qualityGrade: quality.grade,
    qualityReasons: quality.reasons,
  };
}

export function rankWindowCandidates(
  windows: BackgroundCgEventWindow[],
  options: ListBackgroundCgEventWindowsOptions = {},
): BackgroundCgEventWindow[] {
  const hasSpecificFilter = Boolean(options.targetApp || options.bundleId || options.title || options.pid || options.windowId);
  const enriched = windows
    .filter((window) => matchesWindowFilters(window, options))
    .map((window) => enrichWindow(window, options))
    .filter((window): window is BackgroundCgEventWindow => Boolean(window))
    .filter((window) => hasSpecificFilter || (window.qualityScore || 0) >= 45);
  enriched.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0) || a.windowId - b.windowId);
  if (enriched[0]) {
    enriched[0].recommended = true;
  }
  return enriched;
}

function matchesWindowFilters(
  window: BackgroundCgEventWindow,
  options: ListBackgroundCgEventWindowsOptions | BackgroundCgEventClickRequest,
): boolean {
  if (options.targetApp && !matchesTargetApp(window, options.targetApp)) {
    return false;
  }
  if (options.bundleId && window.bundleId !== options.bundleId) {
    return false;
  }
  if (options.title && window.title !== options.title) {
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

export function matchesTargetApp(window: BackgroundCgEventWindow, targetApp: string): boolean {
  const target = normalizeForMatch(targetApp);
  return normalizeForMatch(window.appName) === target
    || normalizeForMatch(window.bundleId || '') === target;
}

function scoreWindowCandidate(
  window: BackgroundCgEventWindow,
  options: ListBackgroundCgEventWindowsOptions | BackgroundCgEventClickRequest,
): { score: number; grade: 'recommended' | 'usable' | 'low'; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (window.layer === 0) {
    score += 24;
    reasons.push('ordinary layer');
  } else {
    score -= 18;
    reasons.push(`non-ordinary layer ${window.layer ?? 'unknown'}`);
  }

  if (window.isOnScreen !== false) {
    score += 10;
  } else {
    score -= 20;
    reasons.push('not on screen');
  }

  if (window.alpha === null || window.alpha === undefined || window.alpha > 0.2) {
    score += 8;
  } else {
    score -= 12;
    reasons.push(`low alpha ${window.alpha}`);
  }

  if (hasReasonableBounds(window.bounds)) {
    score += 20;
    reasons.push('reasonable bounds');
  } else {
    score -= 24;
    reasons.push(`unreasonable bounds ${formatBounds(window.bounds)}`);
  }

  if (isLikelySystemWindowOwner(window)) {
    score -= 35;
    reasons.push('system owner');
  } else {
    score += 18;
    reasons.push('non-system owner');
  }

  if (window.title) {
    score += 8;
    reasons.push('has title');
  } else {
    score -= 4;
    reasons.push('no title');
  }

  if (options.targetApp) {
    if (matchesTargetApp(window, options.targetApp)) {
      score += 18;
      reasons.push('matches targetApp');
    } else {
      score -= 45;
      reasons.push('does not match targetApp');
    }
  }
  if (options.bundleId) {
    if (window.bundleId === options.bundleId) {
      score += 18;
      reasons.push('matches bundleId');
    } else {
      score -= 45;
      reasons.push('does not match bundleId');
    }
  }
  if (options.title) {
    if (window.title === options.title) {
      score += 12;
      reasons.push('matches title');
    } else {
      score -= 25;
      reasons.push('does not match title');
    }
  }
  if (typeof options.pid === 'number') {
    if (window.pid === Math.trunc(options.pid)) {
      score += 12;
      reasons.push('matches pid');
    } else {
      score -= 30;
      reasons.push('does not match pid');
    }
  }
  if (typeof options.windowId === 'number') {
    if (window.windowId === Math.trunc(options.windowId)) {
      score += 12;
      reasons.push('matches windowId');
    } else {
      score -= 30;
      reasons.push('does not match windowId');
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const grade = clamped >= 75 ? 'recommended' : clamped >= 50 ? 'usable' : 'low';
  return {
    score: clamped,
    grade,
    reasons,
  };
}

export function parseDiagnosis(
  record: Record<string, unknown>,
  options: ListBackgroundCgEventWindowsOptions & { helperPath: string },
): BackgroundCgEventAppDiagnosis {
  const rawWindows = Array.isArray(record.windows) ? record.windows : [];
  const windows = rankWindowCandidates(
    rawWindows.map(parseWindow).filter((item): item is BackgroundCgEventWindow => Boolean(item)),
    options,
  );
  const processes = Array.isArray(record.processes)
    ? record.processes.map(parseProcess).filter((item): item is BackgroundCgEventAppDiagnosis['processes'][number] => Boolean(item))
    : [];
  const axPerPid = Array.isArray(record.ax)
    ? record.ax.map(parseAxProbe).filter((item): item is BackgroundCgEventAppDiagnosis['ax']['perPid'][number] => Boolean(item))
    : [];
  const accessibilityTrusted = typeof record.accessibilityTrusted === 'boolean' ? record.accessibilityTrusted : null;
  const screenRecordingGranted = typeof record.screenRecordingGranted === 'boolean' ? record.screenRecordingGranted : null;
  const windowLocationAvailable = typeof record.cgEventSetWindowLocationAvailable === 'boolean'
    ? record.cgEventSetWindowLocationAvailable
    : null;
  const axErrors = axPerPid
    .map((probe) => probe.error)
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
  const axWindowCount = axPerPid.reduce((sum, probe) => sum + probe.windowCount, 0);
  const axReasons: string[] = [];
  if (!accessibilityTrusted) axReasons.push('Accessibility permission is not trusted');
  if (processes.length === 0) axReasons.push('target app is not running');
  if (axWindowCount === 0) axReasons.push('no AX windows returned');
  if (axErrors.length > 0) axReasons.push(`AX probe errors: ${[...new Set(axErrors)].join(', ')}`);
  if (axReasons.length === 0) axReasons.push('AX can read target windows');

  const cgEventReasons: string[] = [];
  if (!screenRecordingGranted) cgEventReasons.push('Screen Recording is not granted; window titles/bounds may be incomplete');
  if (!windowLocationAvailable) cgEventReasons.push('CGEventSetWindowLocation symbol is unavailable; helper can only rely on screen location');
  if (windows.length === 0) cgEventReasons.push('no candidate CGWindow found');
  if (windows[0]?.qualityGrade === 'low') cgEventReasons.push('best candidate window has low quality score');
  if (cgEventReasons.length === 0) cgEventReasons.push('CGEvent has a recommended candidate window');

  return {
    targetApp: typeof record.targetApp === 'string' ? record.targetApp : options.targetApp || null,
    capturedAtMs: typeof record.capturedAtMs === 'number' ? record.capturedAtMs : Date.now(),
    platform: process.platform,
    helper: {
      available: true,
      path: options.helperPath,
    },
    os: {
      version: typeof record.osVersion === 'string' ? record.osVersion : null,
    },
    permissions: {
      accessibilityTrusted,
      screenRecordingGranted,
    },
    symbols: {
      cgEventSetWindowLocationAvailable: windowLocationAvailable,
    },
    processes,
    windows,
    recommendedWindow: windows[0] || null,
    ax: {
      suitable: Boolean(accessibilityTrusted && processes.length > 0 && axWindowCount > 0 && axErrors.length === 0),
      trusted: accessibilityTrusted,
      appWindowCount: axWindowCount,
      errors: [...new Set(axErrors)],
      reasons: axReasons,
      perPid: axPerPid,
    },
    cgEvent: {
      suitable: Boolean(windows.length > 0 && windows[0]?.qualityGrade !== 'low'),
      canUseWindowLocation: windowLocationAvailable,
      candidateWindowCount: windows.length,
      reasons: cgEventReasons,
    },
  };
}

function parseProcess(value: unknown): BackgroundCgEventAppDiagnosis['processes'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number' || typeof record.appName !== 'string') return null;
  return {
    pid: record.pid,
    appName: record.appName,
    bundleId: typeof record.bundleId === 'string' ? record.bundleId : null,
    isActive: typeof record.isActive === 'boolean' ? record.isActive : null,
    activationPolicy: typeof record.activationPolicy === 'string' ? record.activationPolicy : null,
    executablePath: typeof record.executablePath === 'string' ? record.executablePath : null,
  };
}

function parseAxProbe(value: unknown): BackgroundCgEventAppDiagnosis['ax']['perPid'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number') return null;
  return {
    pid: record.pid,
    ok: record.ok === true,
    windowCount: typeof record.windowCount === 'number' ? record.windowCount : 0,
    error: typeof record.error === 'string' ? record.error : null,
  };
}

function createWindowRef(window: BackgroundCgEventWindow): string {
  const hash = createHash('sha256')
    .update([
      window.bundleId || window.appName,
      window.title || '',
      Math.round(window.bounds.x),
      Math.round(window.bounds.y),
      Math.round(window.bounds.width),
      Math.round(window.bounds.height),
    ].join('|'))
    .digest('hex')
    .slice(0, 12);
  return `cgwin:${window.pid}:${window.windowId}:${hash}`;
}

export function resolveWindowRef(windowRef: string | undefined): { pid: number; windowId: number; hash: string } | null {
  if (!windowRef) return null;
  const match = /^cgwin:(\d+):(\d+):([a-f0-9]{12})$/i.exec(windowRef.trim());
  if (!match) return null;
  return {
    pid: Number.parseInt(match[1], 10),
    windowId: Number.parseInt(match[2], 10),
    hash: match[3],
  };
}

function parseBounds(value: unknown): BackgroundCgEventWindowBounds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.x !== 'number'
    || typeof record.y !== 'number'
    || typeof record.width !== 'number'
    || typeof record.height !== 'number'
  ) {
    return null;
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  };
}

function hasReasonableBounds(bounds: BackgroundCgEventWindowBounds): boolean {
  return bounds.width >= 80
    && bounds.height >= 40
    && bounds.width <= 10000
    && bounds.height <= 10000;
}

function formatBounds(bounds: BackgroundCgEventWindowBounds): string {
  return `${roundPoint(bounds.x)},${roundPoint(bounds.y)} ${roundPoint(bounds.width)}x${roundPoint(bounds.height)}`;
}

function roundPoint(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isLikelySystemWindowOwner(window: BackgroundCgEventWindow): boolean {
  const app = normalizeForMatch(window.appName);
  const bundle = normalizeForMatch(window.bundleId || '');
  return [
    'window server',
    'loginwindow',
    'dock',
    'systemuiserver',
    'control center',
    'notificationcenter',
    'wallpaper',
  ].includes(app)
    || bundle.startsWith('com.apple.dock')
    || bundle.startsWith('com.apple.windowserver')
    || bundle === 'com.apple.loginwindow'
    || bundle === 'com.apple.systemuiserver'
    || bundle === 'com.apple.controlcenter'
    || bundle === 'com.apple.notificationcenterui';
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePoint(value: unknown): BackgroundCgEventWindowPoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.x !== 'number' || typeof record.y !== 'number') {
    return null;
  }
  return { x: record.x, y: record.y };
}

export function isFinitePoint(value: BackgroundCgEventWindowPoint | undefined): value is BackgroundCgEventWindowPoint {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
