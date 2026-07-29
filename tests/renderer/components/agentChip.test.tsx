// @vitest-environment jsdom
// ============================================================================
// ux-round2 20d：底栏专家 chip 可删——hover × 按钮与 Delete/Backspace 都恢复
// 默认路由（setActiveAgentId(null)）；chip 本体点击仍打开 /agent 面板。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const chipMocks = vi.hoisted(() => ({
  appState: {
    activeAgentId: 'lanxi',
    setActiveAgentId: vi.fn(),
  },
  agentRegistryState: {
    entries: [{
      id: 'lanxi',
      name: '岚析',
      description: '',
      source: 'user',
      modelTier: 'balanced',
      readonly: false,
      tools: [],
      profession: '内容主理人',
    }],
    isLoaded: true,
    refresh: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof chipMocks.appState) => unknown) => (
    selector ? selector(chipMocks.appState) : chipMocks.appState
  ),
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector?: (state: typeof chipMocks.agentRegistryState) => unknown) => (
    selector ? selector(chipMocks.agentRegistryState) : chipMocks.agentRegistryState
  ),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});
import { AgentChip } from '../../../src/renderer/components/features/chat/ChatInput/AgentChip';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AgentChip 可删除（20d）', () => {
  it('hover × 按钮：删除 = setActiveAgentId(null)，不触发打开面板', () => {
    const onOpenAgentCommand = vi.fn();
    render(<AgentChip onOpenAgentCommand={onOpenAgentCommand} />);

    const removeButton = screen.getByTestId('chat-input-agent-chip-remove');
    expect(removeButton.getAttribute('aria-label')).toContain('岚析');
    fireEvent.click(removeButton);

    expect(chipMocks.appState.setActiveAgentId).toHaveBeenCalledWith(null);
    expect(onOpenAgentCommand).not.toHaveBeenCalled();
  });

  it.each(['Delete', 'Backspace'])('键盘 %s：chip group 聚焦时可删', (key) => {
    render(<AgentChip onOpenAgentCommand={vi.fn()} />);

    fireEvent.keyDown(screen.getByTestId('chat-input-agent-chip-group'), { key });

    expect(chipMocks.appState.setActiveAgentId).toHaveBeenCalledWith(null);
  });

  it('chip 本体点击仍打开 /agent 面板', () => {
    const onOpenAgentCommand = vi.fn();
    render(<AgentChip onOpenAgentCommand={onOpenAgentCommand} />);

    fireEvent.click(screen.getByTestId('chat-input-agent-chip'));

    expect(onOpenAgentCommand).toHaveBeenCalledTimes(1);
    expect(chipMocks.appState.setActiveAgentId).not.toHaveBeenCalled();
  });

  it('无选中专家时不渲染', () => {
    chipMocks.appState.activeAgentId = null;
    const { container } = render(<AgentChip onOpenAgentCommand={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    chipMocks.appState.activeAgentId = 'lanxi';
  });
});
