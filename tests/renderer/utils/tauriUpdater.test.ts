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
const invokeMock = vi.fn();

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
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
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

  it('downloads, shuts down webServer before install, reports progress, then auto-relaunches', async () => {
    const callOrder: string[] = [];
    const download = vi.fn(async (onEvent?: (e: unknown) => void) => {
      callOrder.push('download');
      onEvent?.({ event: 'Started', data: { contentLength: 100 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent?.({ event: 'Finished' });
    });
    const install = vi.fn(async () => {
      callOrder.push('install');
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      callOrder.push(`invoke:${cmd}`);
    });
    checkMock.mockResolvedValue({ currentVersion: '0.16.93', version: '0.16.94', download, install });
    relaunchMock.mockResolvedValue(undefined);

    const phases: string[] = [];
    let lastDownloaded = 0;
    await tauriInstallUpdate((p) => {
      phases.push(p.phase);
      if (p.phase === 'download') lastDownloaded = p.downloaded;
    });

    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('shutdown_web_server_for_update');
    // 跨端合同要求的顺序：先落盘字节，再优雅停 webServer，再 install（Windows 上此后不返回）
    expect(callOrder).toEqual(['download', 'invoke:shutdown_web_server_for_update', 'install']);
    expect(lastDownloaded).toBe(100);
    expect(phases).toContain('download');
    expect(phases).toContain('install');
    expect(phases).toContain('relaunch');
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it('relaunches to recover webServer when install() fails (mac/Linux only path)', async () => {
    const download = vi.fn(async () => {});
    const install = vi.fn(async () => {
      throw new Error('signature verification failed');
    });
    invokeMock.mockResolvedValue(undefined);
    checkMock.mockResolvedValue({ currentVersion: '0.16.93', version: '0.16.94', download, install });
    relaunchMock.mockResolvedValue(undefined);

    await expect(tauriInstallUpdate()).resolves.toBeUndefined();

    expect(install).toHaveBeenCalledTimes(1);
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
