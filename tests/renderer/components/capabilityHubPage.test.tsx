// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../src/renderer/components/features/expert/ExpertPanel', () => ({ ExpertPanel: () => <div /> }));
vi.mock('../../../src/renderer/components/features/cron/CronCenterPanel', () => ({ CronCenterPanel: () => <div /> }));
vi.mock('../../../src/renderer/components/features/settings/tabs/CapabilityCenterSettings', () => ({ CapabilityCenterSettings: () => <div /> }));
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
  it('非管理员不展示能力清单，管理员展示', () => {
    useAuthStore.setState({ user: user(false) });
    render(<CapabilityHubPage />);
    expect(screen.queryByTestId('capability-hub-tab-inventory')).toBeNull();

    cleanup();
    useAuthStore.setState({ user: user(true) });
    render(<CapabilityHubPage />);
    expect(screen.getByTestId('capability-hub-tab-inventory')).toBeTruthy();
  });

  it('渲染五个默认可见能力 tab', () => {
    useAuthStore.setState({ user: user(false) });
    render(<CapabilityHubPage />);
    for (const key of ['experts', 'automation', 'skills', 'connectors', 'plugins']) {
      expect(screen.getByTestId(`capability-hub-tab-${key}`)).toBeTruthy();
    }
  });
});
