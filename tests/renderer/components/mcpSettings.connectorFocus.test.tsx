// @vitest-environment jsdom
// MCPSettings 连接器深链落点横幅：来源措辞 + 显示名（禁裸 id）+ 滚动高亮
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchMcpRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const { mockInvokeDomain, mockRunQuickAction, mockUseInChat, mockLanguage } = vi.hoisted(() => ({
  mockInvokeDomain: vi.fn(),
  mockRunQuickAction: vi.fn(),
  mockUseInChat: vi.fn(),
  mockLanguage: { value: 'zh' as 'zh' | 'en' },
}));

const mcpServers: WorkbenchMcpRegistryItem[] = [];

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: zhText } = await import('../../../src/renderer/i18n/zh');
  const { en: enText } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: mockLanguage.value === 'en' ? enText : zhText,
      language: mockLanguage.value,
    }),
  };
});

vi.mock('../../../src/renderer/hooks/useMcpStatus', () => ({
  useMcpStatus: () => ({
    status: { connectedServers: [], toolCount: 0, resourceCount: 0 },
    serverStates: [],
    isLoading: false,
    reload: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: mcpServers,
    skills: [],
    connectors: [],
    mcpServers,
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    capabilities: { skills: [], connectors: [], mcpServers: [] },
    invocationSummary: { skills: {}, connectors: {}, mcpServers: {} },
    references: [],
    history: [],
    connectorHistory: [],
    mcpHistory: [],
    skillHistory: [],
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => ({
    runningActionKey: null,
    actionErrors: {},
    completedActions: {},
    runQuickAction: mockRunQuickAction,
  }),
}));

vi.mock('../../../src/renderer/hooks/useConnectorInChat', () => ({
  useConnectorInChat: () => mockUseInChat,
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({
    user: { isAdmin: false },
  }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mockInvokeDomain,
  },
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/sections/localBridge', () => ({
  LocalBridgeSection: () => React.createElement('div', null, 'LocalBridge'),
}));

// 卡片锚点按真实 testid 伪造：hook 据此定位滚动目标
vi.mock('../../../src/renderer/components/features/settings/sections', () => ({
  NativeConnectorsSection: () => React.createElement(
    'div',
    { 'data-testid': 'native-connector-card-mail' },
    'MailCard',
  ),
  SaaSConnectorsSection: () => React.createElement(
    'div',
    { 'data-testid': 'saas-connector-feishu' },
    'FeishuCard',
  ),
}));

vi.mock('../../../src/renderer/components/features/settings/McpServerEditor', () => ({
  McpServerEditor: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/McpDiscoverTab', () => ({
  McpDiscoverTab: () => null,
}));

import { MCPSettings } from '../../../src/renderer/components/features/settings/tabs/MCPSettings';

function createScrollSpy() {
  return vi.fn((arg?: boolean | ScrollIntoViewOptions) => {
    void arg;
  });
}

let scrollIntoView: ReturnType<typeof createScrollSpy>;

describe('MCPSettings connector focus landing', () => {
  beforeEach(() => {
    mockLanguage.value = 'zh';
    mockInvokeDomain.mockReset();
    scrollIntoView = createScrollSpy();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ settingsCapabilityFocus: null });
    delete (window.HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('引导来源横幅：显示名、引导措辞，不出现内部 id，并滚动高亮目标卡', async () => {
    useAppStore.setState({
      settingsCapabilityFocus: { kind: 'connector', id: 'feishu', nonce: 11, source: 'onboarding' },
    });
    render(React.createElement(MCPSettings));

    const banner = screen.getByTestId('capability-focus-banner');
    expect(banner.textContent).toContain('来自首启引导：连接飞书');
    // 内部 id 不得出现在横幅里
    expect(banner.textContent).not.toContain('feishu');
    expect(banner.querySelector('.font-mono')).toBeNull();

    // 落点：滚动到 saas-connector-feishu 并挂高亮环
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
    const card = document.querySelector('[data-testid="saas-connector-feishu"]') as HTMLElement;
    expect(scrollIntoView.mock.instances[0]).toBe(card);
    expect(card.classList.contains('connector-focus-ring')).toBe(true);
  });

  it('本机连接器落点：native 卡同样滚动高亮（引导失败后的补偿落点）', async () => {
    useAppStore.setState({
      settingsCapabilityFocus: { kind: 'connector', id: 'mail', nonce: 12, source: 'onboarding' },
    });
    render(React.createElement(MCPSettings));

    expect(screen.getByTestId('capability-focus-banner').textContent).toContain('来自首启引导：连接邮件');
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
    const card = document.querySelector('[data-testid="native-connector-card-mail"]') as HTMLElement;
    expect(scrollIntoView.mock.instances[0]).toBe(card);
    expect(card.classList.contains('connector-focus-ring')).toBe(true);
  });

  it('会话页来源横幅保持原措辞，但同样只展示显示名', () => {
    useAppStore.setState({
      settingsCapabilityFocus: { kind: 'connector', id: 'mail', nonce: 13 },
    });
    render(React.createElement(MCPSettings));

    const banner = screen.getByTestId('capability-focus-banner');
    expect(banner.textContent).toContain(`${zh.settings.mcp.focusPromptPrefix}邮件`);
    expect(banner.textContent).not.toContain('Connector mail');
  });

  it('MCP 来源横幅维持既有形态（MCP + server id）', () => {
    useAppStore.setState({
      settingsCapabilityFocus: { kind: 'mcp', id: 'github', nonce: 14 },
    });
    render(React.createElement(MCPSettings));

    const banner = screen.getByTestId('capability-focus-banner');
    expect(banner.textContent).toContain('MCP');
    expect(banner.querySelector('.font-mono')?.textContent).toBe('github');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('关闭横幅即撤焦点：横幅消失、高亮环撤除', async () => {
    useAppStore.setState({
      settingsCapabilityFocus: { kind: 'connector', id: 'feishu', nonce: 15, source: 'onboarding' },
    });
    render(React.createElement(MCPSettings));
    const card = document.querySelector('[data-testid="saas-connector-feishu"]') as HTMLElement;
    await waitFor(() => {
      expect(card.classList.contains('connector-focus-ring')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: zh.settings.mcp.closeFocusPrompt }));

    expect(screen.queryByTestId('capability-focus-banner')).toBeNull();
    expect(card.classList.contains('connector-focus-ring')).toBe(false);
  });

  it('en：引导横幅 "From setup: connect <name>"，不含内部 id', () => {
    mockLanguage.value = 'en';
    useAppStore.setState({
      settingsCapabilityFocus: { kind: 'connector', id: 'feishu', nonce: 16, source: 'onboarding' },
    });
    render(React.createElement(MCPSettings));

    const banner = screen.getByTestId('capability-focus-banner');
    expect(banner.textContent).toContain('From setup: connect Feishu');
    expect(banner.textContent).not.toContain('feishu');
    expect(en.onboarding.focusFromOnboarding).toBe('From setup: connect {name}');
  });
});
