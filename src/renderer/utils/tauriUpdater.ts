/**
 * Tauri-native update service.
 *
 * Invokes Rust IPC commands registered in src-tauri/src/main.rs:
 *   - check_for_update  → TauriUpdateResult
 *   - install_update    → void (downloads, installs, restarts)
 */

import type { UpdateInfo } from '@shared/contract';

// Mirror the Rust TauriUpdateInfo struct (snake_case from serde)
interface TauriUpdateResult {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  release_notes: string | null;
  date: string | null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) {
    throw new Error('Tauri runtime not available');
  }
  return internals.invoke<T>(cmd, args);
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
  };
}

/**
 * Download and install the update, then restart the app.
 * This call will not return if successful (app restarts).
 */
export async function tauriInstallUpdate(): Promise<void> {
  await invoke<void>('install_update');
}
