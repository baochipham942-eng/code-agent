// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdateSettings } from '../../../src/renderer/components/features/settings/tabs/UpdateSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n/zh';
import ipcService from '../../../src/renderer/services/ipcService';
import type { UpdateInfo } from '../../../src/shared/contract';

const installUpdate = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
  isTauriMode: () => true,
}));
vi.mock('../../../src/renderer/utils/tauriUpdater', () => ({
  tauriGetCurrentVersion: vi.fn().mockResolvedValue('0.16.75'),
  tauriCheckForUpdate: vi.fn(),
  tauriInstallUpdate: installUpdate,
  tauriOpenUpdateUrl: vi.fn(),
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getNativeDesktopPermissionStatus: vi.fn().mockResolvedValue(null),
  isNativeDesktopAvailable: () => false,
}));

const text = zh.settings.update;
const updateInfo: UpdateInfo = { hasUpdate: true, currentVersion: '0.16.75', latestVersion: '0.16.76' };

function renderUpdate() {
  return render(
    <UpdateSettings updateInfo={updateInfo} onUpdateInfoChange={vi.fn()} onShowUpdateModal={vi.fn()} />,
  );
}

async function clickInstall() {
  fireEvent.click(screen.getByRole('button', { name: text.download }));
}

describe('UpdateSettings install guard', () => {
  beforeEach(() => {
    installUpdate.mockResolvedValue(undefined);
    useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
    useSessionStore.setState({ runningSessionIds: new Set() });
    vi.mocked(ipcService.invoke).mockResolvedValue([] as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('running session: asks first, cancel installs nothing, confirm installs', async () => {
    useSessionStore.setState({ runningSessionIds: new Set(['s1', 's2']) });
    renderUpdate();
    await clickInstall();
    await screen.findByText(text.install.confirmRunningMessage.replace('{count}', '2'));
    expect(installUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: text.install.confirmCancel }));
    await waitFor(() => expect(screen.queryByText(text.install.confirmTitle)).toBeNull());
    expect(installUpdate).not.toHaveBeenCalled();

    await clickInstall();
    fireEvent.click(await screen.findByRole('button', { name: text.install.confirmAction }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  it('background task only: asks first', async () => {
    vi.mocked(ipcService.invoke).mockResolvedValue([{ sessionId: 'bg' }] as never);
    renderUpdate();
    await clickInstall();
    await screen.findByText(text.install.confirmRunningMessage.replace('{count}', '1'));
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('no tasks: installs directly without a dialog', async () => {
    renderUpdate();
    await clickInstall();
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(text.install.confirmTitle)).toBeNull();
  });

  it('status query failure: treated as busy, asks first', async () => {
    vi.mocked(ipcService.invoke).mockRejectedValue(new Error('ipc down'));
    renderUpdate();
    await clickInstall();
    await screen.findByText(text.install.confirmUnknownMessage);
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
