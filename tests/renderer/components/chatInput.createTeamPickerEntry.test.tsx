// @vitest-environment jsdom
//
// create-team / create-role 也是内置 skill，所以会出现在斜杠候选面板的技能候选里。
// 2026-07-23 客户端 dogfood 实测：按技能选中只会往输入框加一枚能力芯片并清空输入，
// 用户永远碰不到确认卡——自然路径下那张卡形同不存在。本门钉死：这两个名字走开卡，不走挂能力。

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const storeMocks = vi.hoisted(() => {
  const composerState = {
    selectedSkillIds: [] as string[],
    selectedConnectorIds: [] as string[],
    selectedMcpServerIds: [] as string[],
    setSelectedSkillIds: vi.fn(),
    setSelectedConnectorIds: vi.fn(),
    setSelectedMcpServerIds: vi.fn(),
    setTurnCapabilityScopeMode: vi.fn(),
  };
  const skillState = {
    mountSkill: vi.fn().mockResolvedValue(true),
    setCurrentSession: vi.fn(),
  };
  const appState = {
    openCapabilitySettingsTarget: vi.fn(),
  };
  const sessionState = { createSession: vi.fn().mockResolvedValue({ id: 'session-1' }) };
  return { composerState, skillState, appState, sessionState };
});

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: Object.assign(
    (selector: (state: typeof storeMocks.composerState) => unknown) => selector(storeMocks.composerState),
    { getState: () => storeMocks.composerState },
  ),
}));
vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: Object.assign(
    (selector: (state: typeof storeMocks.skillState) => unknown) => selector(storeMocks.skillState),
    { getState: () => storeMocks.skillState },
  ),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeMocks.appState) => unknown) =>
      (selector ? selector(storeMocks.appState) : storeMocks.appState),
    { getState: () => storeMocks.appState },
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof storeMocks.sessionState) => unknown) => selector(storeMocks.sessionState),
    { getState: () => storeMocks.sessionState },
  ),
}));

import { useChatInputSlashCommands } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSlashCommands';

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    value: '/create-team',
    currentSessionId: 'session-1',
    skillRecommendations: [],
    mountRecommendedSkill: vi.fn().mockResolvedValue(true),
    installRecommendedSkill: vi.fn().mockResolvedValue(true),
    capabilityItems: [],
    openAgentCommand: vi.fn(),
    focusComposer: vi.fn(),
    setValue: vi.fn(),
    setShowSlashPopover: vi.fn(),
    setSlashFilter: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setActiveAgentId: vi.fn(),
    openSeedComposer: vi.fn(),
    ...overrides,
  } as never;
}

function skillCandidate(skillName: string) {
  return {
    id: `skill:${skillName}`,
    kind: 'skill',
    group: 'skill',
    actionKind: 'select-skill',
    label: skillName,
    description: '',
    slashText: `/${skillName}`,
    searchText: skillName,
    effectLabel: '',
    skillName,
    skillLibraryId: 'builtin',
    skillMounted: true,
    icon: null,
    action: vi.fn(),
  } as never;
}

describe('斜杠面板里选中 create-team / create-role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.composerState.selectedSkillIds = [];
  });

  it.each([
    ['create-team', 'team'],
    ['create-role', 'role'],
  ])('选中「%s」技能候选时开确认卡，而不是挂成本轮能力', async (skillName, kind) => {
    const openSeedComposer = vi.fn();
    const params = makeParams({ openSeedComposer });
    const { result } = renderHook(() => useChatInputSlashCommands(params));

    await act(async () => {
      result.current.handleSlashCommandSelect(skillCandidate(skillName));
    });

    expect(openSeedComposer).toHaveBeenCalledWith(kind);
    // 不许再往本轮能力里塞这两个流程 skill（那正是"只加了一枚芯片"的病）
    expect(storeMocks.composerState.setSelectedSkillIds).not.toHaveBeenCalled();
  });

  it('普通技能候选仍然照常挂成本轮能力（别把整条 select-skill 路改坏）', async () => {
    const openSeedComposer = vi.fn();
    const params = makeParams({ openSeedComposer });
    const { result } = renderHook(() => useChatInputSlashCommands(params));

    await act(async () => {
      result.current.handleSlashCommandSelect(skillCandidate('chaogeek-deck'));
    });

    expect(openSeedComposer).not.toHaveBeenCalled();
    expect(storeMocks.composerState.setSelectedSkillIds).toHaveBeenCalled();
  });
});
