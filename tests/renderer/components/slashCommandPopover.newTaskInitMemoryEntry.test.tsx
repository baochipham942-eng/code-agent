// @vitest-environment jsdom
// N-FIX-NEWTASK-INIT-MEMORY-ENTRY-POPOVER-PROBE：空白新任务页（currentSessionId=null）与已有会话里，
// 输入 /init-mem 看到的 slash 候选必须一致，/init-memory 不能只在老会话里可发现。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { BUILTIN_PROMPT_COMMANDS } from '../../../src/shared/commands/builtinPromptCommands';

const appState = vi.hoisted(() => ({
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowDAGPanel: vi.fn(),
  showDAGPanel: false,
  setShowWorkspace: vi.fn(),
  showWorkspace: false,
  setSidebarCollapsed: vi.fn(),
  sidebarCollapsed: false,
  contextHealth: null,
  modelConfig: { provider: 'test', model: 'test' },
}));
const sessionState = vi.hoisted(() => ({
  createSession: vi.fn(),
  clearCurrentSession: vi.fn(),
  archiveSession: vi.fn(),
  addMessage: vi.fn(),
  currentSessionId: null as string | null,
}));
const skillState = vi.hoisted(() => ({
  availableSkills: [],
  mountedSkills: [],
  fetchAvailableSkills: vi.fn(() => Promise.resolve()),
  fetchMountedSkills: vi.fn(() => Promise.resolve()),
  setCurrentSession: vi.fn(),
}));
const composerState = vi.hoisted(() => ({ selectedSkillIds: [], selectedConnectorIds: [] }));
const modeState = vi.hoisted(() => ({ setEffortLevel: vi.fn() }));
const ipc = vi.hoisted(() => ({ unsafeInvoke: vi.fn() }));

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
  unsafeInvoke: ipc.unsafeInvoke,
}));

import { SlashCommandPopover } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';

const initMemory = BUILTIN_PROMPT_COMMANDS.find((c) => c.name === 'init-memory');

async function candidateIdsFor(currentSessionId: string | null): Promise<string[]> {
  sessionState.currentSessionId = currentSessionId;
  const { unmount } = render(
    <SlashCommandPopover
      isOpen
      filter="init-mem"
      agents={[]}
      skillRecommendations={[]}
      capabilityItems={[]}
      capabilitySuggestions={[]}
      onClose={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  // PROMPT_LIST 异步返回后 init-memory 才会出现
  await waitFor(() => {
    expect(document.querySelector('[data-slash-command-id="prompt:init-memory"]')).not.toBeNull();
  });
  const ids = Array.from(document.querySelectorAll('[data-slash-command-id]')).map(
    (el) => el.getAttribute('data-slash-command-id') ?? '',
  );
  unmount();
  return ids;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  ipc.unsafeInvoke.mockImplementation(() => Promise.resolve(BUILTIN_PROMPT_COMMANDS));
});

afterEach(cleanup);

describe('N-FIX-NEWTASK-INIT-MEMORY-ENTRY-POPOVER-PROBE', () => {
  it('真实内置命令里确有 init-memory（夹具形状来自生产常量）', () => {
    expect(initMemory).toBeDefined();
  });

  it('输入 /init-mem：空白新任务页（无会话）与已有会话看到相同的候选', async () => {
    const blank = await candidateIdsFor(null);
    const inSession = await candidateIdsFor('session-1');

    expect(blank).toContain('prompt:init-memory');
    expect(inSession).toEqual(blank);
  });
});
