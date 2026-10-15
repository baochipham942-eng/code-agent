// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdateSettings } from '../../../src/renderer/components/features/settings/tabs/UpdateSettings';
import ipcService from '../../../src/renderer/services/ipcService';
import { zh } from '../../../src/renderer/i18n/zh';
import type { RuntimeAssetsStatus, UpdateInfo } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
  isTauriMode: () => true,
}));
vi.mock('../../../src/renderer/utils/tauriUpdater', () => ({
  tauriGetCurrentVersion: vi.fn().mockResolvedValue('0.16.75'),
  tauriCheckForUpdate: vi.fn(),
  tauriInstallUpdate: vi.fn(),
  tauriOpenUpdateUrl: vi.fn(),
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getNativeDesktopPermissionStatus: vi.fn().mockResolvedValue(null),
  isNativeDesktopAvailable: () => false,
}));

const updateInfo: UpdateInfo = { hasUpdate: false, currentVersion: '0.16.75' };

function runtimeStatus(preparation: RuntimeAssetsStatus['preparation'] = null): RuntimeAssetsStatus {
  return {
    runtimeBaseDir: '/tmp/neo-runtime',
    activeManifestPath: '/tmp/neo-runtime/active.json',
    assets: [{
      id: 'python-env',
      label: 'Python data runtime',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    }],
    summary: { installed: 0, bundledFallback: 0, missing: 1, unsupported: 0 },
    preparation,
  };
}

describe('UpdateSettings runtime asset preparation failure', () => {
  beforeEach(() => {
    vi.mocked(ipcService.invoke).mockResolvedValue(undefined as never);
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'runtimeAssetsStatus') return runtimeStatus();
      return null;
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('refreshes after a rejected prepare so the row becomes failed with Retry', async () => {
    let runtimeStatusCalls = 0;
    vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
      if (action === 'runtimeAssetsStatus') {
        runtimeStatusCalls += 1;
        if (runtimeStatusCalls === 1) return runtimeStatus();
        return runtimeStatus({
          assetId: 'python-env',
          phase: 'failed',
          errorCode: 'PYTHON_RUNTIME_OFFLINE',
          error: 'network unavailable',
        });
      }
      if (action === 'prepareRuntimeAssets') throw new Error('network unavailable');
      return null;
    });

    render(<UpdateSettings updateInfo={updateInfo} onUpdateInfoChange={vi.fn()} onShowUpdateModal={vi.fn()} />);
    const text = zh.settings.update.runtimeAssets;
    fireEvent.click(await screen.findByRole('button', { name: text.installAsset }));

    await waitFor(() => {
      expect(screen.getByText(text.status.installFailed)).toBeTruthy();
      expect(screen.getByRole('button', { name: text.retryAsset })).toBeTruthy();
    });
    expect(runtimeStatusCalls).toBeGreaterThanOrEqual(2);
  });
});
