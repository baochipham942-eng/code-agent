import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  tauriCheckForUpdate,
  tauriGetCurrentVersion,
  tauriOpenUpdateUrl,
} from '../../../src/renderer/utils/tauriUpdater';

const originalWindow = (globalThis as { window?: Window }).window;

function installTauriInvoke(invoke: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke,
        metadata: {
          currentWebview: { windowLabel: 'main', label: 'main' },
          currentWindow: { label: 'main' },
        },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('tauriUpdater', () => {
  it('reads current version without checking updates', async () => {
    const invoke = vi.fn().mockResolvedValue('0.16.65');
    installTauriInvoke(invoke);

    await expect(tauriGetCurrentVersion()).resolves.toBe('0.16.65');
    expect(invoke).toHaveBeenCalledWith('get_app_version', undefined);
  });

  it('maps Tauri update fields into shared UpdateInfo', async () => {
    const invoke = vi.fn().mockResolvedValue({
      has_update: true,
      current_version: '0.16.65',
      latest_version: '0.16.66',
      release_notes: 'Release notes',
      date: '2026-04-27T00:00:00.000Z',
      force_update: false,
      download_url: 'https://example.com/Code.Agent.dmg',
      file_size: 136000000,
    });
    installTauriInvoke(invoke);

    await expect(tauriCheckForUpdate()).resolves.toEqual({
      hasUpdate: true,
      currentVersion: '0.16.65',
      latestVersion: '0.16.66',
      releaseNotes: 'Release notes',
      publishedAt: '2026-04-27T00:00:00.000Z',
      forceUpdate: false,
      downloadUrl: 'https://example.com/Code.Agent.dmg',
      fileSize: 136000000,
    });
  });

  it('opens a cloud update download URL through Tauri', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    installTauriInvoke(invoke);

    await tauriOpenUpdateUrl('https://example.com/Code.Agent.dmg');

    expect(invoke).toHaveBeenCalledWith('open_update_url', {
      url: 'https://example.com/Code.Agent.dmg',
    });
  });
});
