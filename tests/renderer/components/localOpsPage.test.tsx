// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mcpRuntime = vi.hoisted(() => ({ present: true, enabled: true }));

vi.mock('../../../src/renderer/components/features/computerUse/ComputerUseContent', () => ({
  ComputerUseContent: () => <div data-testid="mock-computer-use-content" />,
}));
vi.mock('../../../src/renderer/components/features/browser/BrowserSurfaceContent', () => ({
  BrowserSurfaceContent: () => <div data-testid="mock-browser-surface-content" />,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => mcpRuntime.present
    ? [{ config: { name: 'cua-driver', enabled: mcpRuntime.enabled } }]
    : [],
}));

import { LocalOpsPage } from '../../../src/renderer/components/features/localOps/LocalOpsPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  mcpRuntime.present = true;
  mcpRuntime.enabled = true;
  useAppStore.setState({ showLocalOpsPanel: false, localOpsTab: 'desktop' });
});

afterEach(() => {
  cleanup();
  mcpRuntime.present = true;
  mcpRuntime.enabled = true;
  useAppStore.setState({ showLocalOpsPanel: false, localOpsTab: 'desktop' });
});

describe('LocalOpsPage', () => {
  it('已安装 CUA 且深链桌面时渲染桌面 / 浏览器两个 tab', () => {
    render(<LocalOpsPage />);
    expect(screen.getByTestId('local-ops-tab-desktop')).toBeTruthy();
    expect(screen.getByTestId('local-ops-tab-browser')).toBeTruthy();
    expect(screen.getByTestId('mock-computer-use-content')).toBeTruthy();
    expect(screen.queryByTestId('mock-browser-surface-content')).toBeNull();
  });

  it('openLocalOpsPanel 带 tab 深链时切到浏览器内容', () => {
    useAppStore.getState().openLocalOpsPanel('browser');
    render(<LocalOpsPage />);
    expect(screen.getByTestId('mock-browser-surface-content')).toBeTruthy();
    expect(screen.queryByTestId('mock-computer-use-content')).toBeNull();
    expect(useAppStore.getState().showLocalOpsPanel).toBe(true);
  });

  it('旧的 setShowComputerUsePanel / setShowBrowserSurfacePanel shim 路由进合并页', () => {
    useAppStore.getState().setShowComputerUsePanel(true);
    expect(useAppStore.getState()).toMatchObject({ showLocalOpsPanel: true, localOpsTab: 'desktop' });
    useAppStore.getState().setShowBrowserSurfacePanel(true);
    expect(useAppStore.getState()).toMatchObject({ showLocalOpsPanel: true, localOpsTab: 'browser' });
    useAppStore.getState().setShowComputerUsePanel(false);
    expect(useAppStore.getState().showLocalOpsPanel).toBe(false);
  });

  it('未安装 Computer Use 时移除桌面 tab，并安全降级到浏览器', () => {
    mcpRuntime.present = false;
    useAppStore.setState({ localOpsTab: 'desktop' });
    render(<LocalOpsPage />);

    expect(screen.queryByTestId('local-ops-tab-desktop')).toBeNull();
    expect(screen.getByTestId('local-ops-tab-browser')).toBeTruthy();
    expect(screen.getByTestId('mock-browser-surface-content')).toBeTruthy();
    expect(screen.queryByTestId('mock-computer-use-content')).toBeNull();
  });

  it('禁用的旧 cua-driver 配置不算已安装能力', () => {
    mcpRuntime.enabled = false;
    useAppStore.setState({ localOpsTab: 'desktop' });
    render(<LocalOpsPage />);

    expect(screen.queryByTestId('local-ops-tab-desktop')).toBeNull();
    expect(screen.getByTestId('mock-browser-surface-content')).toBeTruthy();
  });
});
