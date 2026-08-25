// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const composerState = {
  selectedSkillIds: [] as string[],
  selectedConnectorIds: ['tmeet'],
  selectedMcpServerIds: [] as string[],
  setTurnCapabilityScopeMode: vi.fn(),
  setSelectedSkillIds: vi.fn((ids: string[]) => { composerState.selectedSkillIds = ids; }),
  setSelectedConnectorIds: vi.fn((ids: string[]) => { composerState.selectedConnectorIds = ids; }),
  setSelectedMcpServerIds: vi.fn((ids: string[]) => { composerState.selectedMcpServerIds = ids; }),
};

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  ),
}));

const registryState = {
  connectors: [{
    kind: 'connector' as const,
    key: 'connector:tmeet',
    id: 'tmeet',
    label: 'tmeet',
    selected: true,
    available: true,
    blocked: false,
    lifecycle: { installState: 'installed', mountState: 'mounted', connectionState: 'connected' },
  }],
  mcpServers: [] as unknown[],
};

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ items: [], skills: [], ...registryState }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      chatInput: { connectorIconRemoveAria: '取消挂载 {name}' },
      settings: { saasConnectors: { providers: { feishu: '飞书', tmeet: '腾讯会议' } } },
    },
  }),
}));

import { MountedConnectorIcons } from '../../../src/renderer/components/features/chat/ChatInput/MountedConnectorIcons';

describe('MountedConnectorIcons（底栏挂载连接器 chip）', () => {
  beforeEach(() => {
    composerState.selectedConnectorIds = ['tmeet'];
    registryState.connectors[0].selected = true;
    vi.clearAllMocks();
  });

  it('常驻显示已挂载 connector 的名称，并提供独立移除动作', () => {
    render(<MountedConnectorIcons />);

    const chip = screen.getByTestId('mounted-capability-connector-tmeet');
    expect(chip.textContent).toContain('腾讯会议');
    expect(chip.textContent).not.toContain('tmeet');
    expect(chip.title).toBe('腾讯会议');
    expect(screen.getByRole('img', { name: '腾讯会议' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消挂载 腾讯会议' })).toBeTruthy();
    expect(screen.getByTestId('mounted-connector-icons')).toBeTruthy();
  });

  it('点击 chip 的移除动作取消挂载', () => {
    render(<MountedConnectorIcons />);

    fireEvent.click(screen.getByRole('button', { name: '取消挂载 腾讯会议' }));

    expect(composerState.selectedConnectorIds).toEqual([]);
  });

  it('无挂载时不渲染', () => {
    registryState.connectors[0].selected = false;
    const { container } = render(<MountedConnectorIcons />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('mounted-connector-icons')).toBeNull();
  });
});
