/**
 * Tauri-native desktop foundation bridge.
 *
 * P0 scope:
 * - capability discovery
 * - permission probing
 * - frontmost context snapshot
 * - native screenshot capture
 */

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
  return !!window.__TAURI_INTERNALS__;
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

export async function captureNativeDesktopScreenshot(outputPath?: string): Promise<ScreenshotCaptureResult> {
  return invoke<ScreenshotCaptureResult>('desktop_capture_screenshot', {
    request: { outputPath },
  });
}

export async function getNativeDesktopCollectorStatus(): Promise<NativeDesktopCollectorStatus> {
  return invoke<NativeDesktopCollectorStatus>('desktop_get_collector_status');
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
  vadReady: boolean;
  soxAvailable: boolean;
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
    const resp = await fetch('/api/domain/desktop/getAudioSegments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getAudioSegments', payload: { from, to } }),
    });
    if (!resp.ok) return [];
    const result = await resp.json();
    return result?.success ? (result.data || []) : [];
  } catch {
    return [];
  }
}

async function postDesktopAction<T>(action: string, payload?: Record<string, unknown>): Promise<T | null> {
  try {
    const resp = await fetch('/api/domain/desktop/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
    if (!resp.ok) return null;
    const result = await resp.json();
    return result?.success ? (result.data || null) : null;
  } catch {
    return null;
  }
}

export async function startAudioCapture(): Promise<AudioCaptureStatus | null> {
  return postDesktopAction<AudioCaptureStatus>('startAudioCapture');
}

export async function stopAudioCapture(): Promise<AudioCaptureStatus | null> {
  return postDesktopAction<AudioCaptureStatus>('stopAudioCapture');
}

export async function getAudioCaptureStatus(): Promise<AudioCaptureStatus | null> {
  return postDesktopAction<AudioCaptureStatus>('getAudioCaptureStatus');
}

export async function openNativeDesktopSystemSettings(kind: SettingsPaneKind): Promise<boolean> {
  return invoke<boolean>('desktop_open_system_settings', {
    request: { kind },
  });
}
