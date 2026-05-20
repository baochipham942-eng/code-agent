/**
 * Tauri-native desktop foundation bridge.
 *
 * P0 scope:
 * - capability discovery
 * - permission probing
 * - frontmost context snapshot
 * - native screenshot capture
 */

import { IPC_DOMAINS, type IPCResponse } from '@shared/ipc';

export interface NativeDesktopCapabilities {
  platform: string;
  supportsScreenCapture: boolean;
  supportsPermissionChecks: boolean;
  supportsFrontmostContext: boolean;
  supportsBrowserContext: boolean;
  supportsSystemSettingsLinks: boolean;
  supportsBackgroundCollection: boolean;
  phase: string;
}

export interface NativePermissionStatus {
  kind: string;
  status: 'granted' | 'denied' | 'unknown' | 'unsupported';
  detail?: string | null;
}

export interface NativePermissionSnapshot {
  platform: string;
  checkedAtMs: number;
  permissions: NativePermissionStatus[];
}

export interface FrontmostContextSnapshot {
  platform: string;
  capturedAtMs: number;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  browserUrl?: string | null;
  browserTitle?: string | null;
  documentPath?: string | null;
  sessionState?: string | null;
  idleSeconds?: number | null;
  powerSource?: string | null;
  onAcPower?: boolean | null;
  batteryPercent?: number | null;
  batteryCharging?: boolean | null;
}

export interface ScreenshotCaptureResult {
  path: string;
  bytes: number;
  capturedAtMs: number;
}

export interface DesktopActivityEvent {
  id: string;
  capturedAtMs: number;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  browserUrl?: string | null;
  browserTitle?: string | null;
  documentPath?: string | null;
  sessionState?: string | null;
  idleSeconds?: number | null;
  powerSource?: string | null;
  onAcPower?: boolean | null;
  batteryPercent?: number | null;
  batteryCharging?: boolean | null;
  screenshotPath?: string | null;
  analyzeText?: string | null;
  fingerprint: string;
}

export interface NativeDesktopCollectorStatus {
  running: boolean;
  phase: string;
  intervalSecs: number;
  captureScreenshots: boolean;
  redactSensitiveContexts?: boolean | null;
  retentionDays?: number | null;
  dedupeWindowSecs: number;
  maxRecentEvents: number;
  lastEventAtMs?: number | null;
  lastCleanupAtMs?: number | null;
  lastError?: string | null;
  lastFingerprint?: string | null;
  totalEventsWritten: number;
  eventDir?: string | null;
  screenshotDir?: string | null;
  eventsFile?: string | null;
  sqliteDbPath?: string | null;
}

export interface WorkbenchActionTrace {
  id: string;
  targetKind: 'browser' | 'computer';
  toolName: string;
  action: string;
  mode: string;
  startedAtMs: number;
  completedAtMs?: number | null;
  failureKind?: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction?: string | null;
  evidenceSummary?: string[];
  axQuality?: ComputerSurfaceAxQuality | null;
}

export type ComputerSurfaceFailureKind =
  | 'permission_denied'
  | 'target_app_not_running'
  | 'target_not_frontmost'
  | 'target_window_not_found'
  | 'ax_unavailable'
  | 'ax_tree_poor'
  | 'locator_missing'
  | 'locator_ambiguous'
  | 'coordinate_untrusted'
  | 'action_execution_failed'
  | 'evidence_unavailable';

export type ComputerSurfaceAxQualityGrade = 'good' | 'usable' | 'poor';

export interface ComputerSurfaceAxQuality {
  score: number;
  grade: ComputerSurfaceAxQualityGrade;
  elementCount: number;
  labeledElementCount: number;
  withAxPathCount: number;
  unlabeledRatio: number;
  missingAxPathRatio: number;
  duplicateLabelRoleCount: number;
  roleCounts: Record<string, number>;
  reasons: string[];
}

export interface ComputerSurfaceState {
  id: string;
  mode: 'background_ax' | 'background_cgevent' | 'foreground_fallback' | 'background_surface_unavailable';
  platform: string;
  ready: boolean;
  background: boolean;
  requiresForeground?: boolean;
  approvalScope?: 'session_app' | 'per_action' | 'blocked';
  safetyNote?: string | null;
  targetApp?: string | null;
  blockedReason?: string | null;
  approvedApps: string[];
  deniedApps: string[];
  lastAction?: WorkbenchActionTrace | null;
  lastSnapshot?: {
    capturedAtMs: number;
    appName?: string | null;
    windowTitle?: string | null;
    screenshotPath?: string | null;
  } | null;
  failureKind?: ComputerSurfaceFailureKind | null;
  blockingReasons?: string[];
  recommendedAction?: string | null;
  evidenceSummary?: string[];
  axQuality?: ComputerSurfaceAxQuality | null;
}

export interface ComputerSurfaceObservationResult {
  snapshot: {
    capturedAtMs: number;
    appName?: string | null;
    windowTitle?: string | null;
    screenshotPath?: string | null;
    failureKind?: ComputerSurfaceFailureKind | null;
    blockingReasons?: string[];
    recommendedAction?: string | null;
  };
  state: ComputerSurfaceState;
}

export interface ComputerSurfaceElementsResult {
  state: ComputerSurfaceState;
  output?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface NativeDesktopCollectorRequest {
  intervalSecs?: number;
  captureScreenshots?: boolean;
  redactSensitiveContexts?: boolean;
  retentionDays?: number;
  dedupeWindowSecs?: number;
  maxRecentEvents?: number;
}

type SettingsPaneKind = 'screenCapture' | 'accessibility';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) {
    throw new Error('Tauri runtime not available');
  }
  return internals.invoke<T>(cmd, args);
}

export function isNativeDesktopAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

export async function getNativeDesktopCapabilities(): Promise<NativeDesktopCapabilities> {
  return invoke<NativeDesktopCapabilities>('desktop_get_capabilities');
}

export async function getNativeDesktopPermissionStatus(): Promise<NativePermissionSnapshot> {
  return invoke<NativePermissionSnapshot>('desktop_get_permission_status');
}

export async function getFrontmostDesktopContext(): Promise<FrontmostContextSnapshot> {
  return invoke<FrontmostContextSnapshot>('desktop_get_frontmost_context');
}

export interface AppIconResult {
  /** data:image/png;base64,... */
  dataUrl: string;
  /** Resolved app bundle path */
  appPath: string;
}

/**
 * 通过 NSWorkspace 拿 macOS app 图标，输出 base64 PNG dataURL。
 * query 可以是 bundle id（com.apple.Safari）或显示名（"Safari"）。
 * 仅在 Tauri 桌面模式下可用，dev:web / 非 macOS 会 throw。
 */
export async function getMacOSAppIcon(query: string, size = 64): Promise<AppIconResult> {
  return invoke<AppIconResult>('desktop_get_app_icon', { query, size });
}

export async function captureNativeDesktopScreenshot(outputPath?: string): Promise<ScreenshotCaptureResult> {
  return invoke<ScreenshotCaptureResult>('desktop_capture_screenshot', {
    request: { outputPath },
  });
}

export async function getNativeDesktopCollectorStatus(): Promise<NativeDesktopCollectorStatus> {
  return invoke<NativeDesktopCollectorStatus>('desktop_get_collector_status');
}

export async function getComputerSurfaceState(): Promise<ComputerSurfaceState> {
  return postDesktopAction<ComputerSurfaceState>('getComputerSurfaceState');
}

export async function startNativeDesktopCollector(
  request: NativeDesktopCollectorRequest = {}
): Promise<NativeDesktopCollectorStatus> {
  return invoke<NativeDesktopCollectorStatus>('desktop_start_collector', { request });
}

export async function stopNativeDesktopCollector(): Promise<NativeDesktopCollectorStatus> {
  return invoke<NativeDesktopCollectorStatus>('desktop_stop_collector');
}

export async function listRecentNativeDesktopEvents(limit = 8): Promise<DesktopActivityEvent[]> {
  return invoke<DesktopActivityEvent[]>('desktop_list_recent_events', { limit });
}

export async function updateNativeDesktopAnalyzeText(eventId: string, analyzeText: string): Promise<boolean> {
  return invoke<boolean>('desktop_update_analyze_text', {
    eventId,
    analyzeText,
  });
}

export interface AudioCaptureStatus {
  capturing: boolean;
  captureMode: 'microphone' | 'system-audio';
  vadReady: boolean;
  soxAvailable: boolean;
  systemAudioAvailable: boolean;
  asrEngine: string;
  powerMode: string;
  totalSegments: number;
  audioDir: string;
  queueLength: number;
}

export interface AudioSegment {
  id: string;
  start_at_ms: number;
  end_at_ms: number;
  duration_ms: number;
  wav_path?: string | null;
  transcript: string;
  speaker_id?: number | null;
  asr_engine?: string | null;
}

export async function listAudioSegments(from: number, to: number): Promise<AudioSegment[]> {
  try {
    return await postDesktopAction<AudioSegment[]>('getAudioSegments', { from, to });
  } catch {
    return [];
  }
}

function getAuthHeaders(): Record<string, string> {
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined;
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIPCResponse<T>(value: unknown): IPCResponse<T> {
  if (!isRecord(value) || typeof value.success !== 'boolean') {
    return {
      success: false,
      error: { code: 'INVALID_RESPONSE', message: '操作失败' },
    };
  }
  if (!value.success) {
    const error = isRecord(value.error) ? value.error : {};
    return {
      success: false,
      error: {
        code: typeof error.code === 'string' ? error.code : 'DOMAIN_ERROR',
        message: typeof error.message === 'string' ? error.message : '操作失败',
        details: error.details,
      },
    };
  }
  return { success: true, data: value.data as T };
}

async function postDesktopAction<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
  const resp = await fetch('/api/domain/desktop/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ action, payload }),
  });
  if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
  const payloadValue: unknown = await resp.json();
  const result = parseIPCResponse<T>(payloadValue);
  if (!result.success) {
    throw new Error(result.error?.message || '操作失败');
  }
  return result.data as T;
}

async function invokeDesktopDomain<T>(
  action: string,
  payload?: Record<string, unknown>,
): Promise<IPCResponse<T>> {
  const bridge = window.codeAgentDomainAPI || window.domainAPI;
  if (bridge) {
    return bridge.invoke<T>(IPC_DOMAINS.DESKTOP, action, payload);
  }

  const resp = await fetch('/api/domain/desktop/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ action, payload }),
  });
  if (!resp.ok) {
    return {
      success: false,
      error: {
        code: 'HTTP_ERROR',
        message: `请求失败: ${resp.status}`,
      },
    };
  }
  const payloadValue: unknown = await resp.json();
  return parseIPCResponse<T>(payloadValue);
}

export async function startAudioCapture(mode: 'microphone' | 'system-audio' = 'microphone'): Promise<AudioCaptureStatus> {
  return postDesktopAction<AudioCaptureStatus>('startAudioCapture', { mode });
}

/** 后台请求麦克风权限（不阻塞 UI，app 启动时调用一次） */
export async function requestMicrophonePermission(): Promise<string> {
  if (!isNativeDesktopAvailable()) return 'unsupported';
  try {
    return await invoke<string>('desktop_request_microphone_permission');
  } catch {
    return 'error';
  }
}

export async function stopAudioCapture(): Promise<AudioCaptureStatus> {
  const status = await postDesktopAction<AudioCaptureStatus>('stopAudioCapture');
  // 停止 Tauri 端的 rec 进程
  if (isNativeDesktopAvailable()) {
    try {
      await invoke<boolean>('desktop_stop_audio_rec');
    } catch { /* best effort */ }
  }
  return status;
}

export async function getAudioCaptureStatus(): Promise<AudioCaptureStatus | null> {
  try {
    return await postDesktopAction<AudioCaptureStatus>('getAudioCaptureStatus');
  } catch {
    return null;
  }
}

export async function observeComputerSurface(
  request: { targetApp?: string; includeScreenshot?: boolean } = {},
): Promise<IPCResponse<ComputerSurfaceObservationResult>> {
  return invokeDesktopDomain<ComputerSurfaceObservationResult>('observeComputerSurface', request);
}

export async function listComputerSurfaceElements(
  request: { targetApp?: string; limit?: number; maxDepth?: number },
): Promise<IPCResponse<ComputerSurfaceElementsResult>> {
  return invokeDesktopDomain<ComputerSurfaceElementsResult>('listComputerSurfaceElements', request);
}

export async function readComputerSurfaceState(
  request: { targetApp?: string } = {},
): Promise<IPCResponse<ComputerSurfaceState>> {
  return invokeDesktopDomain<ComputerSurfaceState>('getComputerSurfaceState', request);
}

export async function openNativeDesktopSystemSettings(kind: SettingsPaneKind): Promise<boolean> {
  return invoke<boolean>('desktop_open_system_settings', {
    request: { kind },
  });
}
