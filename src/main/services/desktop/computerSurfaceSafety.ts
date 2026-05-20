import type {
  ComputerSurfaceFailureKind,
  ComputerSurfaceMode,
} from '../../../shared/contract/desktop';

export interface ComputerSurfaceSafetyAction {
  action: string;
  targetApp?: string;
  text?: string;
  key?: string;
  name?: string;
  selector?: string;
  role?: string;
  x?: number;
  y?: number;
}

export interface ComputerSurfacePreflightBlock {
  failureKind: ComputerSurfaceFailureKind;
  blockingReasons: string[];
  recommendedAction: string;
}

export const DEFAULT_DENIED_APPS = [
  'Terminal',
  'iTerm',
  'iTerm2',
  'Agent Neo',
  'Codex',
  'System Settings',
  'System Preferences',
  'Keychain Access',
  '1Password',
];

const SELF_APP_NAME = 'Agent Neo';

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
const LAUNCH_ACTIONS = new Set(['open_application']);

export function parseComputerSurfaceAppList(value: string | undefined, fallback: string[]): string[] {
  const items = (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export function canUseComputerSurfaceBackground(
  backgroundEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && backgroundEnabled;
}

export function getDefaultComputerSurfaceMode(args: {
  backgroundEnabled: boolean;
  platform?: NodeJS.Platform;
}): ComputerSurfaceMode {
  const platform = args.platform || process.platform;
  if (canUseComputerSurfaceBackground(args.backgroundEnabled, platform)) {
    return 'background_ax';
  }
  return platform === 'darwin'
    ? 'foreground_fallback'
    : 'background_surface_unavailable';
}

export function isComputerSurfaceModeReady(
  mode: ComputerSurfaceMode,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && mode !== 'background_surface_unavailable';
}

export function computerSurfaceModeRequiresForeground(mode: ComputerSurfaceMode): boolean {
  return mode === 'foreground_fallback';
}

export function getComputerSurfaceSafetyNote(mode: ComputerSurfaceMode): string {
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

export function isDeniedComputerSurfaceApp(targetApp: string, deniedApps: string[]): boolean {
  return deniedApps.some((item) => item.toLowerCase() === targetApp.toLowerCase());
}

export function isComputerSurfaceSelfApp(targetApp: string): boolean {
  return targetApp.trim().toLowerCase() === SELF_APP_NAME.toLowerCase();
}

export function isReadBlockedComputerSurfaceApp(targetApp: string, deniedApps: string[]): boolean {
  return isDeniedComputerSurfaceApp(targetApp, deniedApps) && !isComputerSurfaceSelfApp(targetApp);
}

export function buildDeniedComputerSurfaceBlock(actionDescription: string): ComputerSurfacePreflightBlock {
  return {
    failureKind: 'permission_denied',
    blockingReasons: [`Computer Surface blocked ${actionDescription} for a protected app.`],
    recommendedAction: 'Choose a non-protected target app or remove the app from the denied list intentionally.',
  };
}

export function canUseBackgroundAxComputerSurfaceAction(
  action: ComputerSurfaceSafetyAction,
  args: {
    backgroundAvailable: boolean;
    hasElementLocator: boolean;
  },
): boolean {
  return args.backgroundAvailable
    && Boolean(action.targetApp)
    && BACKGROUND_AX_ACTIONS.has(action.action)
    && args.hasElementLocator
    && action.x === undefined
    && action.y === undefined;
}

export function canUseBackgroundCgEventComputerSurfaceAction(
  action: ComputerSurfaceSafetyAction,
  args: {
    backgroundAvailable: boolean;
    hasCgEventRequest: boolean;
  },
): boolean {
  return args.backgroundAvailable
    && Boolean(action.targetApp)
    && BACKGROUND_CGEVENT_ACTIONS.has(action.action)
    && args.hasCgEventRequest;
}

export function isBackgroundCgEventComputerSurfaceAction(action: string): boolean {
  return BACKGROUND_CGEVENT_ACTIONS.has(action);
}

export function isComputerSurfaceLaunchAction(action: string): boolean {
  return LAUNCH_ACTIONS.has(action);
}

export function isSensitiveComputerSurfaceAction(action: ComputerSurfaceSafetyAction): boolean {
  const content = [action.text, action.key, action.name, action.selector, action.role]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /password|passcode|token|secret|credit card|cvv|payment|pay now|transfer|wire|delete account|admin|sudo/.test(content);
}

export function redactComputerSurfaceAction<T extends object>(action: T): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action as Record<string, unknown>)) {
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
