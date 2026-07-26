// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/components/features/computerUse/ComputerUseContent', () => ({
  ComputerUseContent: () => <div data-testid="mock-computer-use-content" />,
}));
vi.mock('../../../src/renderer/components/features/browser/BrowserSurfaceContent', () => ({
  BrowserSurfaceContent: () => <div data-testid="mock-browser-surface-content" />,
}));

import { LocalOpsPage } from '../../../src/renderer/components/features/localOps/LocalOpsPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';

afterEach(() => {
  cleanup();
  useAppStore.setState({ showLocalOpsPanel: false, localOpsTab: 'desktop' });
});

describe('LocalOpsPage', () => {
  it('渲染「本机操作」的桌面 / 浏览器两个 tab，默认落在桌面', () => {
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
});
