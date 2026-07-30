// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const composerState = {
  selectedSkillIds: [] as string[],
  selectedConnectorIds: [] as string[],
  selectedMcpServerIds: [] as string[],
  pendingCommand: null as { id: string; name: string } | null,
  setSelectedSkillIds: vi.fn((ids: string[]) => { composerState.selectedSkillIds = ids; }),
  setSelectedConnectorIds: vi.fn(),
  setSelectedMcpServerIds: vi.fn(),
  setTurnCapabilityScopeMode: vi.fn(),
  setPendingCommand: vi.fn((command: { id: string; name: string } | null) => { composerState.pendingCommand = command; }),
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
import {
  createCommandCandidate,
  removeTrailingSlashToken,
} from '../../../src/renderer/components/features/chat/ChatInput/slashPickerModel';
import type { SlashCommand } from '../../../src/renderer/components/features/chat/ChatInput/SlashCommandPopover';

// insertInlineChip 的测试替身：编辑器侧「触发词原位变 chip」在这里等价于摘掉尾 token
// （chip 挂载点 / 内联位置的验证在 chatInput.inlineChips.test.tsx）。
function makeParams(
  inputValue: string,
  setValue: (next: string | ((previous: string) => string)) => void,
  insertInlineChip = vi.fn(),
) {
  return {
    value: inputValue,
    currentSessionId: 'session-1',
    skillRecommendations: [],
    mountRecommendedSkill: vi.fn(),
    installRecommendedSkill: vi.fn(),
    capabilityItems: [],
    openAgentCommand: vi.fn(),
    focusComposer: vi.fn(),
    insertInlineChip,
    setValue,
    setShowSlashPopover: vi.fn(),
    setSlashFilter: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setActiveAgentId: vi.fn(),
    openSeedComposer: vi.fn(),
  };
}

describe('useChatInputSlashCommands', () => {
  it('selects a skill without inserting its name into the input value', async () => {
    composerState.selectedSkillIds = [];
    let inputValue = '帮我处理 /doc';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const insertInlineChip = vi.fn(() => { inputValue = removeTrailingSlashToken(inputValue); });
    const { result } = renderHook(() => useChatInputSlashCommands({
      value: inputValue,
      currentSessionId: 'session-1',
      skillRecommendations: [],
      mountRecommendedSkill: vi.fn(),
      installRecommendedSkill: vi.fn(),
      capabilityItems: [],
      openAgentCommand: vi.fn(),
      focusComposer: vi.fn(),
      insertInlineChip,
      setValue,
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingPromptCommand: vi.fn(),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
      openSeedComposer: vi.fn(),
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

  it('带参特色命令（/goal 等 prefill-leading-command）选中后 chip 化：挂 pendingCommand、清触发文本', () => {
    composerState.pendingCommand = null;
    let inputValue = '/go';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const insertInlineChip = vi.fn(() => { inputValue = removeTrailingSlashToken(inputValue); });
    const { result } = renderHook(() => useChatInputSlashCommands(makeParams(inputValue, setValue, insertInlineChip)));

    const goalCommand: SlashCommand = {
      ...createCommandCandidate({ id: 'goal', label: '设定目标', description: '直接输入目标', actionKind: 'prefill-leading-command' }),
      icon: null,
      action: vi.fn(),
    };
    act(() => {
      result.current.handleSlashCommandSelect(goalCommand);
    });

    // chip 挂上、触发词原位替换为内联 chip、不再留「/goal 」纯文本前缀（任务 17）
    expect(composerState.pendingCommand).toEqual({ id: 'goal', name: '设定目标' });
    expect(insertInlineChip).toHaveBeenCalledWith({ key: 'command:goal', kind: 'command', id: 'goal' });
    expect(inputValue).toBe('');
    expect(goalCommand.action).not.toHaveBeenCalled();
  });

  it('立即执行类命令（/new 等 execute）不 chip 化，行为不变', () => {
    composerState.pendingCommand = null;
    let inputValue = '/ne';
    const setValue = vi.fn((next: string | ((previous: string) => string)) => {
      inputValue = typeof next === 'function' ? next(inputValue) : next;
    });
    const { result } = renderHook(() => useChatInputSlashCommands(makeParams(inputValue, setValue)));

    const newCommand: SlashCommand = {
      ...createCommandCandidate({ id: 'new', label: '新建会话', description: '创建会话' }),
      icon: null,
      action: vi.fn(),
    };
    act(() => {
      result.current.handleSlashCommandSelect(newCommand);
    });

    expect(composerState.pendingCommand).toBeNull();
    expect(newCommand.action).toHaveBeenCalledTimes(1);
  });
});
