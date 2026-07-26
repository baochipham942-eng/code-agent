// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

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
  it('只渲染四个能力 tab', () => {
    useAuthStore.setState({ user: user(false) });
    render(<CapabilityHubPage />);
    for (const key of ['experts', 'skills', 'connectors', 'plugins']) {
      expect(screen.getByTestId(`capability-hub-tab-${key}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('capability-hub-tab-automation')).toBeNull();
    expect(screen.queryByTestId('capability-hub-tab-inventory')).toBeNull();
  });

  it('提示词入口仅 admin 可见（2026-07 方案 9C 从用户菜单迁入）', () => {
    useAuthStore.setState({ user: user(false) });
    const { unmount } = render(<CapabilityHubPage />);
    expect(screen.queryByTestId('capability-hub-open-prompts')).toBeNull();
    unmount();

    useAuthStore.setState({ user: user(true) });
    render(<CapabilityHubPage />);
    expect(screen.getByTestId('capability-hub-open-prompts')).toBeTruthy();
  });
});
