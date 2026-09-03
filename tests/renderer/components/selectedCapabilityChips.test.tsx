// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const composerState = {
  selectedSkillIds: ['docx'],
  selectedConnectorIds: [] as string[],
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

const skillState = { mountSource: 'manual' as 'manual' | 'auto' };

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: [],
    skills: [{
      kind: 'skill' as const,
      key: 'skill:docx',
      id: 'docx',
      label: 'Docx',
      selected: composerState.selectedSkillIds.includes('docx'),
      available: true,
      blocked: false,
      lifecycle: { installState: 'installed', mountState: 'mounted', connectionState: 'not_applicable' },
      mountSource: skillState.mountSource,
    }],
    connectors: [],
    mcpServers: [],
  }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

import { SelectedCapabilityChips } from '../../../src/renderer/components/features/chat/ChatInput/SelectedCapabilityChips';

describe('SelectedCapabilityChips', () => {
  beforeEach(() => {
    cleanup();
    composerState.selectedSkillIds = ['docx'];
    skillState.mountSource = 'manual';
    vi.clearAllMocks();
  });

  it('点击 × 按钮移除已选 skill', () => {
    const { container } = render(<SelectedCapabilityChips />);

    expect(screen.getByRole('button', { name: '移除能力：Docx' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除能力：Docx' }));

    expect(composerState.selectedSkillIds).toEqual([]);
    expect(container.querySelector('[data-testid="selected-capability-chips"]')).toBeTruthy();
  });

  it('chip 本体可聚焦，但点击本体不再删除（防误点）', () => {
    render(<SelectedCapabilityChips />);

    const chip = screen.getByRole('group', { name: 'Docx' });
    fireEvent.click(chip);

    expect(composerState.selectedSkillIds).toEqual(['docx']);
  });

  it('chip 聚焦后按 Delete / Backspace 删除', () => {
    render(<SelectedCapabilityChips />);

    const chip = screen.getByRole('group', { name: 'Docx' });
    fireEvent.keyDown(chip, { key: 'Delete' });
    expect(composerState.selectedSkillIds).toEqual([]);

    composerState.selectedSkillIds = ['docx'];
    fireEvent.keyDown(chip, { key: 'Backspace' });
    expect(composerState.selectedSkillIds).toEqual([]);
  });

  it('悬停胶囊：用户自己挂的写「你在本会话加的」，本轮生效', () => {
    render(<SelectedCapabilityChips />);
    expect(screen.queryByTestId('selected-capability-source-docx')).toBeNull();

    fireEvent.mouseEnter(screen.getByRole('group', { name: 'Docx' }).parentElement!);
    const card = screen.getByTestId('selected-capability-source-docx');
    expect(card.textContent).toContain('你在本会话加的');
    expect(card.textContent).toContain('本轮生效');
  });

  it('悬停胶囊：新会话默认挂上的写「默认带的」并说明 ✕ 可移除', () => {
    skillState.mountSource = 'auto';
    render(<SelectedCapabilityChips />);

    fireEvent.mouseEnter(screen.getByRole('group', { name: 'Docx' }).parentElement!);
    const card = screen.getByTestId('selected-capability-source-docx');
    expect(card.textContent).toContain('默认带的');
    expect(card.textContent).toContain('点 ✕ 可移除');
    expect(card.textContent).not.toContain('你在本会话加的');
  });
});
