// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
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
  it('renders a selected registry skill and removes it from composer state', () => {
    const { container } = render(<SelectedCapabilityChips />);

    expect(screen.getByRole('button', { name: '移除能力：Docx' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除能力：Docx' }));

    expect(composerState.selectedSkillIds).toEqual([]);
    expect(container.querySelector('[data-testid="selected-capability-chips"]')).toBeTruthy();
  });
});
