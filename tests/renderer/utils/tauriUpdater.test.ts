import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  tauriCheckForUpdate,
  tauriGetCurrentVersion,
  tauriInstallUpdate,
  tauriOpenUpdateUrl,
} from '../../../src/renderer/utils/tauriUpdater';

const checkMock = vi.fn();
const getVersionMock = vi.fn();
const openUrlMock = vi.fn();
const relaunchMock = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: (...args: unknown[]) => getVersionMock(...args),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('tauriUpdater (plugin-based)', () => {
  it('reads current version via core app API', async () => {
    getVersionMock.mockResolvedValue('0.16.93');
    await expect(tauriGetCurrentVersion()).resolves.toBe('0.16.93');
  });

  it('maps a plugin Update into shared UpdateInfo', async () => {
    checkMock.mockResolvedValue({
      currentVersion: '0.16.93',
      version: '0.16.94',
      body: 'Release notes',
      date: '2026-06-06T01:24:49.062Z',
    });

    await expect(tauriCheckForUpdate()).resolves.toEqual({
      hasUpdate: true,
      currentVersion: '0.16.93',
      latestVersion: '0.16.94',
      releaseNotes: 'Release notes',
      publishedAt: '2026-06-06T01:24:49.062Z',
    });
  });

  it('reports no update (not a failure) when plugin check returns null', async () => {
    checkMock.mockResolvedValue(null);
    getVersionMock.mockResolvedValue('0.16.94');

    const info = await tauriCheckForUpdate();
    expect(info.hasUpdate).toBe(false);
    expect(info.checkFailed).toBeUndefined();
  });

  it('downloads, installs, reports progress, then auto-relaunches', async () => {
    const downloadAndInstall = vi.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent?.({ event: 'Finished' });
    });
    checkMock.mockResolvedValue({ currentVersion: '0.16.93', version: '0.16.94', downloadAndInstall });
    relaunchMock.mockResolvedValue(undefined);

    const phases: string[] = [];
    let lastDownloaded = 0;
    await tauriInstallUpdate((p) => {
      phases.push(p.phase);
      if (p.phase === 'download') lastDownloaded = p.downloaded;
    });

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(lastDownloaded).toBe(100);
    expect(phases).toContain('download');
    expect(phases).toContain('install');
    expect(phases).toContain('relaunch');
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when asked to install with no update available', async () => {
    checkMock.mockResolvedValue(null);
    await expect(tauriInstallUpdate()).rejects.toThrow();
  });

  it('opens a manual download URL through the opener plugin', async () => {
    openUrlMock.mockResolvedValue(undefined);
    await tauriOpenUpdateUrl('https://example.com/Agent.Neo.dmg');
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/Agent.Neo.dmg');
  });
});
