// @vitest-environment jsdom
// ============================================================================
// Settings「本机功能」LibreOffice 行渲染 — N-PY-RUNTIME-K3 rework r1
//
// 复检缺口：上一轮只测了纯 mapper，没有证据表明 Settings > 本机功能区块真的
// 渲染出 LibreOffice 行。这里 mount 整个 UpdateSettings，喂含 libreoffice 资产
// 的 runtimeAssetsStatus，断言 zh/en 双语下显示名与四态（已可用 / 首次使用时下载 /
// 安装中+百分比 / 失败+LibreOffice 专属原因+重试）真实上屏；host 英文原始串
// （label「LibreOffice document renderer」、error「host detail」）绝不作主文案。
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdateSettings } from '../../../src/renderer/components/features/settings/tabs/UpdateSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import ipcService from '../../../src/renderer/services/ipcService';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { RuntimeAssetStatusEntry, RuntimeAssetsStatus, UpdateInfo } from '../../../src/shared/contract';

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
const HOST_LABEL = 'LibreOffice document renderer';
const RAW_HOST_ERROR = 'host detail';

function libreOfficeAsset(state: RuntimeAssetStatusEntry['state']): RuntimeAssetStatusEntry {
  return {
    id: 'libreoffice',
    label: HOST_LABEL,
    delivery: 'optional',
    state,
    nodeModules: [],
  };
}

function runtimeStatus(
  asset: RuntimeAssetStatusEntry,
  preparation: RuntimeAssetsStatus['preparation'] = null,
): RuntimeAssetsStatus {
  return {
    runtimeBaseDir: '/tmp/neo-runtime',
    activeManifestPath: '/tmp/neo-runtime/active.json',
    assets: [asset],
    summary: { installed: 0, bundledFallback: 0, missing: 1, unsupported: 0 },
    preparation,
  };
}

type Locale = 'zh' | 'en';

async function mountSettings(
  locale: Locale,
  asset: RuntimeAssetStatusEntry,
  preparation: RuntimeAssetsStatus['preparation'] = null,
) {
  useAppStore.setState({ language: locale });
  vi.mocked(ipcService.invokeDomain).mockImplementation(async (_domain, action) => {
    if (action === 'runtimeAssetsStatus') return runtimeStatus(asset, preparation);
    return null;
  });
  render(<UpdateSettings updateInfo={updateInfo} onUpdateInfoChange={vi.fn()} onShowUpdateModal={vi.fn()} />);
  await screen.findByTestId('runtime-asset-row-libreoffice');
}

beforeEach(() => {
  vi.mocked(ipcService.invoke).mockResolvedValue(undefined as never);
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' });
});

describe.each([
  ['zh', zh.settings.update.runtimeAssets],
  ['en', en.settings.update.runtimeAssets],
] as const)('Settings 本机功能 LibreOffice 行渲染（%s）', (locale, text) => {
  it('installed ⇒ 显示名 + 可用徽章', async () => {
    await mountSettings(locale, libreOfficeAsset('installed'));
    // 显示名来自 displayNames（zh「LibreOffice 文档渲染」/ en「LibreOffice document rendering」），
    // 不是 host label 原文「LibreOffice document renderer」
    expect(screen.getByText(text.displayNames.libreOffice)).toBeTruthy();
    expect(document.body.textContent).not.toContain(HOST_LABEL);
    expect(screen.getByText(text.status.available)).toBeTruthy();
  });

  it('missing ⇒ 首次使用时下载徽章', async () => {
    await mountSettings(locale, libreOfficeAsset('missing'));
    expect(screen.getByText(text.displayNames.libreOffice)).toBeTruthy();
    expect(screen.getByText(text.status.firstUseDownload)).toBeTruthy();
  });

  it('preparation installing 37% ⇒ 安装中徽章带百分比', async () => {
    await mountSettings(locale, libreOfficeAsset('missing'), {
      assetId: 'libreoffice',
      phase: 'installing',
      percent: 37.2,
    });
    expect(screen.getByText(`${text.status.installing} 37%`)).toBeTruthy();
  });

  it('preparation failed ⇒ LibreOffice 专属失败原因 + 重试 + 查看日志，host 原文不进可见文本', async () => {
    await mountSettings(locale, libreOfficeAsset('missing'), {
      assetId: 'libreoffice',
      phase: 'failed',
      errorCode: 'LIBREOFFICE_RUNTIME_INSTALL_FAILED',
      error: RAW_HOST_ERROR,
      logPath: '/tmp/neo-libreoffice/install.log',
    });
    expect(screen.getByText(text.status.installFailed)).toBeTruthy();
    // 主文案是 LibreOffice 专属本地化原因，不是 host 英文原文
    expect(screen.getByTestId('runtime-asset-failure-libreoffice').textContent).toBe(text.failureReasons.libreOfficeInstallFailed);
    expect(document.body.textContent).not.toContain(RAW_HOST_ERROR);
    // 原文经 title 提示可达（排查用）
    expect(screen.getByTestId('runtime-asset-failure-libreoffice').getAttribute('title')).toBe(RAW_HOST_ERROR);
    const retry = screen.getByRole('button', { name: text.retryAsset });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalledWith(
        expect.anything(),
        'prepareRuntimeAssets',
        expect.objectContaining({ assetId: 'libreoffice' }),
      );
    });
    expect(screen.getByTestId('runtime-asset-open-log-libreoffice').textContent).toBe(text.openInstallLog);
  });
});
