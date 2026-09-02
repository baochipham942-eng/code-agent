// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPackage } from '../../../src/shared/contract/capabilityPackage';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

import { CapabilityPackageCard } from '../../../src/renderer/components/features/settings/tabs/CapabilityPackageCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function plugin(state: InstalledCapabilityPackage['state'], error?: string): InstalledCapabilityPackage {
  return {
    id: 'evaluation-center',
    name: '评测中心',
    version: '1.0.0',
    description: '质量回归与版本验收',
    permissions: [],
    state,
    surface: 'internal-feature',
    toolNames: [],
    internalFeature: {
      id: 'evaluation-center',
      label: '评测中心',
      sdkVersion: { host: 'host0001', renderer: 'renderer' },
      rendererEntry: 'dist/renderer/index.js',
      rendererStyles: 'dist/renderer/index.css',
      hostEntry: 'dist/host/index.cjs',
      ...(state === 'active' ? { loadedHash: 'package1' } : {}),
    },
    ...(error ? { error } : {}),
  };
}

function thirdPartyUiPlugin(error: string): InstalledCapabilityPackage {
  return {
    id: 'third-party-ui',
    name: '第三方插件',
    version: '1.0.0',
    description: '界面装载测试',
    permissions: [],
    state: 'error',
    surface: 'ui',
    toolNames: [],
    error,
  };
}

const callbacks = {
  onInstall: vi.fn(),
  onUninstall: vi.fn(),
  onReinstall: vi.fn(),
  onRunVersion: vi.fn(),
};

beforeEach(() => {
  Object.values(callbacks).forEach((callback) => callback.mockReset());
  useAppStore.setState({ activeInternalFeatureId: null, showCapabilityHub: true });
});

afterEach(cleanup);

describe('CapabilityPackageCard internal plugin states', () => {
  it('active 卡显示状态提示，并列提供打开和卸载', () => {
    const installed = plugin('active');
    render(
      <CapabilityPackageCard
        plugin={installed}
        busyKey={null}
        packageBusy={false}
        {...callbacks}
      />,
    );

    expect(screen.getByText('已启用，可在左下角菜单打开')).toBeTruthy();
    const open = screen.getByRole('button', { name: '打开' });
    const uninstall = screen.getByRole('button', { name: '卸载' });
    expect(open.parentElement).toBe(uninstall.parentElement);

    fireEvent.click(open);
    expect(useAppStore.getState()).toMatchObject({
      activeInternalFeatureId: 'evaluation-center',
      showCapabilityHub: false,
    });
  });

  it('error 卡原样展示 L1 错误，并提供重新安装和卸载', () => {
    const failed = plugin('error', '与当前版本不匹配，请安装新版插件');
    render(
      <CapabilityPackageCard
        plugin={failed}
        busyKey={null}
        packageBusy={false}
        {...callbacks}
      />,
    );

    expect(screen.getByText('这个插件没能启动：与当前版本不匹配，请安装新版插件')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新安装' }));
    expect(callbacks.onReinstall).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '卸载' })).toBeTruthy();
  });

  it('第三方插件沿用同一条 error 展示和重新安装入口', () => {
    render(
      <CapabilityPackageCard
        plugin={thirdPartyUiPlugin('界面文件加载失败')}
        busyKey={null}
        packageBusy={false}
        {...callbacks}
      />,
    );

    expect(screen.getByText('这个插件没能启动：界面文件加载失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新安装' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '卸载' })).toBeTruthy();
  });
});
