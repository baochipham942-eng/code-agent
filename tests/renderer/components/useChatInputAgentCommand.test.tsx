// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { AgentListEntry } from '../../../src/shared/contract/agentRegistry';

const neoWorkCardState = vi.hoisted(() => ({
  detailsById: {},
  loadAll: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/renderer/stores/neoWorkCardStore', () => ({
  useNeoWorkCardStore: Object.assign(
    (selector: (state: typeof neoWorkCardState) => unknown) => selector(neoWorkCardState),
    { getState: () => neoWorkCardState },
  ),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

import { useChatInputAgentCommand } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputAgentCommand';

const agents: AgentListEntry[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Writes and debugs code.',
    // 传统内置 agent 已从用户可选入口隐藏；面板用例统一走自建 agent
    source: 'user',
    modelTier: 'balanced',
    readonly: false,
    tools: [],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code quality.',
    source: 'user',
    modelTier: 'balanced',
    readonly: true,
    tools: [],
  },
];

function setup(value: string) {
  const state = {
    value,
    setValue: vi.fn((next: string | ((previous: string) => string)) => {
      state.value = typeof next === 'function' ? next(state.value) : next;
    }),
    setShowSlashPopover: vi.fn(),
    setSlashFilter: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setActiveAgentId: vi.fn(),
  };
  const hook = renderHook(() => useChatInputAgentCommand({
    value: state.value,
    swarmAgents: [],
    agentEntries: agents,
    inputAreaRef: { current: null },
    focusComposer: vi.fn(),
    setValue: state.setValue,
    setShowSlashPopover: state.setShowSlashPopover,
    setSlashFilter: state.setSlashFilter,
    setPendingAgentSelection: state.setPendingAgentSelection,
    setActiveAgentId: state.setActiveAgentId,
  }));
  return { state, hook };
}

function keyEvent(init: { key: string; keyCode?: number; isComposing?: boolean }) {
  return {
    key: init.key,
    shiftKey: false,
    preventDefault: vi.fn(),
    nativeEvent: {
      isComposing: init.isComposing ?? false,
      keyCode: init.keyCode ?? 0,
    },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe('useChatInputAgentCommand', () => {
  it('二级面板选中 agent：chip 立即生效 + 清空 /agent 触发文本', () => {
    const { state, hook } = setup('/agent rev');

    act(() => {
      hook.result.current.handleAgentCommandOptionSelect(0);
    });

    expect(state.setActiveAgentId).toHaveBeenCalledWith('reviewer');
    expect(state.setPendingAgentSelection).toHaveBeenCalledWith({
      id: 'reviewer',
      name: 'Reviewer',
      token: 'reviewer',
      via: 'agent_command',
    });
    expect(state.value).toBe('');
  });

  it('面板已无 Default 项：选项全部是具体专家（恢复默认路由 = 删 chip）', () => {
    const { hook } = setup('/agent ');
    const options = hook.result.current.agentCommandOptions;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.id !== null)).toBe(true);
  });

  it('Enter 正常选择面板项（对照组）', () => {
    const { state, hook } = setup('/agent rev');
    const event = keyEvent({ key: 'Enter', keyCode: 13 });

    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(state.setActiveAgentId).toHaveBeenCalledWith('reviewer');
  });

  it('IME 组合中的 Enter（keyCode 229）不触发选择，放行给输入法', () => {
    const { state, hook } = setup('/agent rev');
    const event = keyEvent({ key: 'Enter', keyCode: 229 });

    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(event);
    });

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.setActiveAgentId).not.toHaveBeenCalled();
    expect(state.value).toBe('/agent rev');
  });

  it('IME isComposing 中的 Enter 同样不触发选择', () => {
    const { state, hook } = setup('/agent rev');
    const event = keyEvent({ key: 'Enter', isComposing: true });

    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(event);
    });

    expect(handled).toBe(false);
    expect(state.setActiveAgentId).not.toHaveBeenCalled();
  });

  it('@ mention 面板：IME 组合中的 Enter 不插入 mention', () => {
    const state = {
      value: '@al',
      setValue: vi.fn((next: string | ((previous: string) => string)) => {
        state.value = typeof next === 'function' ? next(state.value) : next;
      }),
      setShowSlashPopover: vi.fn(),
      setSlashFilter: vi.fn(),
      setPendingAgentSelection: vi.fn(),
      setActiveAgentId: vi.fn(),
    };
    const hook = renderHook(() => useChatInputAgentCommand({
      value: state.value,
      swarmAgents: [{ id: 'agent-alpha', name: 'alpha' }],
      agentEntries: agents,
      inputAreaRef: { current: null },
      focusComposer: vi.fn(),
      setValue: state.setValue,
      setShowSlashPopover: state.setShowSlashPopover,
      setSlashFilter: state.setSlashFilter,
      setPendingAgentSelection: state.setPendingAgentSelection,
      setActiveAgentId: state.setActiveAgentId,
    }));
    expect(hook.result.current.isAgentMentionAutocompleteOpen).toBe(true);

    const imeEvent = keyEvent({ key: 'Enter', keyCode: 229 });
    let handled: boolean | undefined;
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(imeEvent);
    });
    expect(handled).toBe(false);
    expect(imeEvent.preventDefault).not.toHaveBeenCalled();
    expect(state.value).toBe('@al');

    // 对照：普通 Enter 正常插入 @alpha
    const normalEvent = keyEvent({ key: 'Enter', keyCode: 13 });
    act(() => {
      handled = hook.result.current.handleAutocompleteKeyDown(normalEvent);
    });
    expect(handled).toBe(true);
    expect(state.value).toBe('@alpha ');
  });
});
