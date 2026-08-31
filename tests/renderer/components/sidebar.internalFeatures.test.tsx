// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPackage } from '../../../src/shared/contract/capabilityPackage';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

import { SidebarAccountMenu } from '../../../src/renderer/components/features/sidebar/SidebarAccountMenu';
import { useInternalFeatureStore } from '../../../src/renderer/internalFeatures/internalFeatureStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const installed: InstalledCapabilityPackage = {
  id: 'evaluation-center',
  name: '评测中心',
  version: '1.0.0',
  description: 'fixture',
  permissions: [],
  state: 'active',
  surface: 'internal-feature',
  toolNames: [],
  internalFeature: {
    id: 'evaluation-center',
    label: '评测中心',
    sdkVersion: { host: 'host0001', renderer: 'renderer' },
    rendererEntry: 'dist/renderer/index.js',
    rendererStyles: 'dist/renderer/index.css',
    hostEntry: 'dist/host/index.cjs',
    loadedHash: 'package1',
  },
};

const props = {
  onClose: vi.fn(),
  advancedToolsOpen: false,
  onToggleAdvancedTools: vi.fn(),
  hasActiveAdvancedTool: false,
};

beforeEach(() => {
  props.onClose.mockReset();
  useInternalFeatureStore.setState({ features: [installed], loadedAt: 1 });
  useAppStore.setState({ activeInternalFeatureId: null });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('SidebarAccountMenu internal plugins', () => {
  it('非管理员即使拿到残留列表也不显示入口', () => {
    useAuthStore.setState({ user: { id: 'user', email: 'user@example.com', isAdmin: false } });
    render(<SidebarAccountMenu {...props} />);
    expect(screen.queryByTestId('account-menu-internal-evaluation-center')).toBeNull();
  });

  it('管理员有 active 内部插件时在提示词管理后显示入口', () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    render(<SidebarAccountMenu {...props} />);
    const prompt = screen.getByTestId('user-menu-open-prompt-manager');
    const internal = screen.getByTestId('account-menu-internal-evaluation-center');
    expect(prompt.compareDocumentPosition(internal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(internal);
    expect(useAppStore.getState().activeInternalFeatureId).toBe('evaluation-center');
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('列表为空时管理员也不显示入口', () => {
    useAuthStore.setState({ user: { id: 'admin', email: 'admin@example.com', isAdmin: true } });
    useInternalFeatureStore.setState({ features: [] });
    render(<SidebarAccountMenu {...props} />);
    expect(screen.queryByTestId('account-menu-internal-evaluation-center')).toBeNull();
  });
});
