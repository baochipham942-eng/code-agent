/**
 * Tauri-native update service.
 *
 * Invokes Rust IPC commands registered in src-tauri/src/main.rs:
 *   - get_app_version   → string
 *   - check_for_update  → TauriUpdateResult
 *   - install_update    → void (downloads, installs, restarts)
 *   - open_update_url   → void (opens a manual download URL)
 */

import type { UpdateInfo } from '@shared/contract';

// Mirror the Rust TauriUpdateInfo struct (snake_case from serde)
interface TauriUpdateResult {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  release_notes: string | null;
  date: string | null;
  force_update: boolean | null;
  download_url: string | null;
  file_size: number | null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) {
    throw new Error('Tauri runtime not available');
  }
  return internals.invoke<T>(cmd, args);
}

/**
 * Read the Tauri app version without performing a network update check.
 */
export async function tauriGetCurrentVersion(): Promise<string> {
  return invoke<string>('get_app_version');
}

/**
 * Check for updates via Tauri updater plugin.
 * Returns an UpdateInfo object compatible with the existing UI.
 */
export async function tauriCheckForUpdate(): Promise<UpdateInfo> {
  const result = await invoke<TauriUpdateResult>('check_for_update');
  return {
    hasUpdate: result.has_update,
    currentVersion: result.current_version,
    latestVersion: result.latest_version ?? undefined,
    releaseNotes: result.release_notes ?? undefined,
    publishedAt: result.date ?? undefined,
    forceUpdate: result.force_update ?? undefined,
    downloadUrl: result.download_url ?? undefined,
    fileSize: result.file_size ?? undefined,
  };
}

/**
 * Download and install the update, then restart the app.
 * This call will not return if successful (app restarts).
 */
export async function tauriInstallUpdate(): Promise<void> {
  await invoke<void>('install_update');
}

/**
 * Open the download URL returned by the cloud update service.
 */
export async function tauriOpenUpdateUrl(downloadUrl: string): Promise<void> {
  await invoke<void>('open_update_url', { url: downloadUrl });
}
