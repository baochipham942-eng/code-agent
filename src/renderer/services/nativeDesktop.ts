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
  fingerprint: string;
}

export interface NativeDesktopCollectorStatus {
  running: boolean;
  phase: string;
  intervalSecs: number;
  captureScreenshots: boolean;
  dedupeWindowSecs: number;
  maxRecentEvents: number;
  lastEventAtMs?: number | null;
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

export async function openNativeDesktopSystemSettings(kind: SettingsPaneKind): Promise<boolean> {
  return invoke<boolean>('desktop_open_system_settings', {
    request: { kind },
  });
}
