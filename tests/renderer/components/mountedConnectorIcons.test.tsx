// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const composerState = {
  selectedSkillIds: [] as string[],
  selectedConnectorIds: ['lark'],
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
    key: 'connector:lark',
    id: 'lark',
    label: '飞书',
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
  useI18n: () => ({ t: { chatInput: { connectorIconRemoveAria: '取消挂载 {name}' } } }),
}));

import { MountedConnectorIcons } from '../../../src/renderer/components/features/chat/ChatInput/MountedConnectorIcons';

describe('MountedConnectorIcons（底栏挂载连接器图标）', () => {
  beforeEach(() => {
    composerState.selectedConnectorIds = ['lark'];
    registryState.connectors[0].selected = true;
    vi.clearAllMocks();
  });

  it('渲染已挂载 connector 的首字符图标，tooltip 是名称', () => {
    render(<MountedConnectorIcons />);

    const icon = screen.getByRole('button', { name: '取消挂载 飞书' });
    expect(icon.title).toBe('飞书');
    expect(screen.getByTestId('mounted-connector-icons')).toBeTruthy();
  });

  it('点击图标取消挂载', () => {
    render(<MountedConnectorIcons />);

    fireEvent.click(screen.getByRole('button', { name: '取消挂载 飞书' }));

    expect(composerState.selectedConnectorIds).toEqual([]);
  });

  it('无挂载时不渲染', () => {
    registryState.connectors[0].selected = false;
    const { container } = render(<MountedConnectorIcons />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('mounted-connector-icons')).toBeNull();
  });
});
