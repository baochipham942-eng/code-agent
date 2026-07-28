// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../src/renderer/components/features/expert/ExpertPanel', () => ({ ExpertPanel: () => <div /> }));
vi.mock('../../../src/renderer/components/features/settings/tabs/SkillsSettings', () => ({ SkillsSettings: () => <div /> }));
vi.mock('../../../src/renderer/components/features/settings/tabs/MCPSettings', () => ({ MCPSettings: () => <div /> }));
vi.mock('../../../src/renderer/components/features/settings/tabs/PluginsSettings', () => ({ PluginsSettings: () => <div /> }));

import { CapabilityHubPage } from '../../../src/renderer/components/features/capabilityHub/CapabilityHubPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const user = (isAdmin: boolean) => ({ id: 'u1', email: 'u@example.com', isAdmin });

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  useAppStore.setState({ showCapabilityHub: false, capabilityHubTab: 'experts' });
});

describe('CapabilityHubPage', () => {
  it('普通用户只看到专家、技能和连接器（插件 tab 隐藏，代码与深链保留）', () => {
    useAuthStore.setState({ user: user(false) });
    render(<CapabilityHubPage />);
    for (const key of ['experts', 'skills', 'connectors']) {
      expect(screen.getByTestId(`capability-hub-tab-${key}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('capability-hub-tab-plugins')).toBeNull();
    expect(screen.queryByTestId('capability-hub-tab-automation')).toBeNull();
    expect(screen.queryByTestId('capability-hub-tab-inventory')).toBeNull();
  });

  it('管理员看到 plugins tab（工单要求 admin 可达路径保留）', () => {
    useAuthStore.setState({ user: user(true) });
    render(<CapabilityHubPage />);
    expect(screen.getByTestId('capability-hub-tab-plugins')).toBeTruthy();
  });

  it('普通用户从 plugins 深链进入时回退到 experts，不白屏', async () => {
    useAuthStore.setState({ user: user(false) });
    useAppStore.setState({ capabilityHubTab: 'plugins' });
    render(<CapabilityHubPage />);

    await waitFor(() => expect(useAppStore.getState().capabilityHubTab).toBe('experts'));
  });

  it('不再承载提示词入口（2026-07-27 二次拍板：迁账号菜单 admin 档）', () => {
    useAuthStore.setState({ user: user(false) });
    const { unmount } = render(<CapabilityHubPage />);
    expect(screen.queryByTestId('capability-hub-open-prompts')).toBeNull();
    unmount();

    useAuthStore.setState({ user: user(true) });
    render(<CapabilityHubPage />);
    expect(screen.queryByTestId('capability-hub-open-prompts')).toBeNull();
  });
});
