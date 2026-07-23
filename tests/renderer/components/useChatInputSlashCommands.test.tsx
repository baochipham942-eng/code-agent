// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const composerState = {
  selectedSkillIds: [] as string[],
  selectedConnectorIds: [] as string[],
  selectedMcpServerIds: [] as string[],
  setSelectedSkillIds: vi.fn((ids: string[]) => { composerState.selectedSkillIds = ids; }),
  setSelectedConnectorIds: vi.fn(),
  setSelectedMcpServerIds: vi.fn(),
  setTurnCapabilityScopeMode: vi.fn(),
};

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof composerState) => unknown) => selector(composerState),
    { getState: () => composerState },
  ),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: () => vi.fn() }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: () => vi.fn() }));
vi.mock('../../../src/renderer/stores/skillStore', () => ({ useSkillStore: () => vi.fn() }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('../../../src/renderer/utils/startCreateRoleChat', () => ({ startCreateRoleChat: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: { sidebar: { newSessionTitle: '新会话' }, slashSelect: {} } }),
}));

import { useChatInputSlashCommands } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSlashCommands';

describe('useChatInputSlashCommands', () => {
  it('selects a skill without inserting its name into the input value', async () => {
    composerState.selectedSkillIds = [];
    let inputValue = '帮我处理 /doc';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const { result } = renderHook(() => useChatInputSlashCommands({
      value: inputValue,
      currentSessionId: 'session-1',
      skillRecommendations: [],
      mountRecommendedSkill: vi.fn(),
      installRecommendedSkill: vi.fn(),
      capabilityItems: [],
      openAgentCommand: vi.fn(),
      focusComposer: vi.fn(),
      setValue,
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingPromptCommand: vi.fn(),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
    }));

    await act(async () => {
      await result.current.selectSkillForCurrentTurn({
        skillName: 'docx',
        libraryId: 'office',
        mounted: true,
      });
    });

    expect(composerState.selectedSkillIds).toEqual(['docx']);
    expect(inputValue).toBe('帮我处理');
    expect(inputValue).not.toContain('<docx>');
  });
});
