// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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
    }],
    connectors: [],
    mcpServers: [],
  }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: { selectedCapabilityChips: { removeAria: '移除能力：{name}' } } }),
}));

import { SelectedCapabilityChips } from '../../../src/renderer/components/features/chat/ChatInput/SelectedCapabilityChips';

describe('SelectedCapabilityChips', () => {
  beforeEach(() => {
    composerState.selectedSkillIds = ['docx'];
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
});
