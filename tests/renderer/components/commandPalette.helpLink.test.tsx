// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const appState = vi.hoisted(() => ({
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowDAGPanel: vi.fn(),
  showDAGPanel: false,
  setShowWorkspace: vi.fn(),
  showWorkspace: false,
  setSidebarCollapsed: vi.fn(),
  sidebarCollapsed: false,
  openWorkbenchTab: vi.fn(),
  previewTabs: [],
  contextHealth: null,
  modelConfig: { provider: 'test', model: 'test' },
}));
const sessionState = vi.hoisted(() => ({
  createSession: vi.fn(),
  clearCurrentSession: vi.fn(),
  archiveSession: vi.fn(),
  addMessage: vi.fn(),
  currentSessionId: 'session-1',
}));
const skillState = vi.hoisted(() => ({
  availableSkills: [],
  mountedSkills: [],
  fetchAvailableSkills: vi.fn(() => Promise.resolve()),
  fetchMountedSkills: vi.fn(() => Promise.resolve()),
  setCurrentSession: vi.fn(),
}));
const composerState = vi.hoisted(() => ({
  selectedSkillIds: [],
  selectedConnectorIds: [],
}));
const modeState = vi.hoisted(() => ({
  setInteractionMode: vi.fn(),
  setEffortLevel: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(() => appState, { getState: () => appState }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(() => sessionState, { getState: () => sessionState }),
}));
vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: Object.assign(
    (selector: (state: typeof skillState) => unknown) => selector(skillState),
    { getState: () => skillState },
  ),
}));
vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  ),
}));
vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: (selector: (state: typeof modeState) => unknown) => selector(modeState),
}));
vi.mock('../../../src/renderer/stores/statusStore', () => ({
  useStatusStore: { getState: () => ({ workingDirectory: '/tmp' }) },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({ keybindings: {}, platform: 'mac' }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});
vi.mock('@shared/keybindings', () => ({
  formatShortcutForDisplay: vi.fn(),
  getKeybindingAccelerator: vi.fn(() => undefined),
}));
vi.mock('@shared/commands', () => ({
  initializeCommands: vi.fn(),
  getCommandRegistry: () => ({ list: () => [] }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  invokeDomain: vi.fn(() => Promise.resolve()),
  unsafeInvoke: vi.fn(() => new Promise(() => {})),
}));

import { AGENT_NEO_HELP_URL } from '../../../src/shared/constants/network';
import { CommandPalette } from '../../../src/renderer/components/CommandPalette';
import { SlashCommandPopover } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('Agent Neo help links', () => {
  it('opens the shared Agent Neo repository URL from CommandPalette', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<CommandPalette isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /帮助/ }));

    expect(open).toHaveBeenCalledWith(AGENT_NEO_HELP_URL, '_blank');
    expect(open.mock.calls[0]?.[0]).not.toContain('anthropics/claude-code');
  });

  it('opens the same shared URL from the /help command action', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onSelect = vi.fn();

    render(
      <SlashCommandPopover
        isOpen
        filter="help"
        agents={[]}
        skillRecommendations={[]}
        capabilityItems={[]}
        capabilitySuggestions={[]}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    onSelect.mock.calls[0]?.[0].action();

    expect(open).toHaveBeenCalledWith(AGENT_NEO_HELP_URL, '_blank');
    expect(open.mock.calls[0]?.[0]).not.toContain('anthropics/claude-code');
  });
});
