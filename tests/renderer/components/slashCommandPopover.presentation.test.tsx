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
  availableSkills: [
    { name: 'alpha', description: 'Alpha 技能', promptContent: '', basePath: '/skills/alpha/SKILL.md', allowedTools: [], disableModelInvocation: false, userInvocable: true, executionContext: 'inline', source: 'builtin' },
    { name: 'beta', description: 'Beta 技能', promptContent: '', basePath: '/skills/beta/SKILL.md', allowedTools: [], disableModelInvocation: false, userInvocable: true, executionContext: 'inline', source: 'builtin' },
  ],
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

import { SlashCommandPopover } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('SlashCommandPopover 候选行呈现', () => {
  it('技能候选用首字母头像，且不再渲染英文 kind 标签', () => {
    render(
      <SlashCommandPopover
        isOpen
        filter="alpha"
        agents={[]}
        skillRecommendations={[]}
        capabilityItems={[]}
        capabilitySuggestions={[]}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    // 先确认确实渲染出了候选行——否则下面的"不出现"断言会因空列表天然通过（假绿）
    const rows = document.querySelectorAll('[data-slash-command-id]');
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // 技能行用首字母头像
    expect(screen.getByTestId('role-initial-avatar-skill:alpha')).toBeTruthy();

    // 精确整词断言：旧 kind 标签 span 的 textContent 恰好是 'Skill'/'Command' 等；
    // 描述里的「已挂载 Skill」不是整词相等，不会误伤。改动前这条必红。
    const kindWords = new Set(['Command', 'Prompt', 'Agent', 'Skill', 'Connector', 'MCP']);
    const offenders = Array.from(document.querySelectorAll('[data-slash-command-id] span'))
      .filter((el) => kindWords.has((el.textContent || '').trim()));
    expect(offenders).toHaveLength(0);
  });
});
