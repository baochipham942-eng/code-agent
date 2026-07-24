// @vitest-environment jsdom
// ============================================================================
// 输入框上方那一格的优先级：确认卡 > 成员条
// ----------------------------------------------------------------------------
// 确认卡是阻塞性决策（不确认没法往下走），成员条是状态展示。被挤掉时成员条收成
// 一行极窄摘要而不是整条消失——WorkBuddy 的 `!dependencyGateNode && teamSlot`
// 就是直接吞掉，用户看不到成员也不知道为什么（2026-07-23 扒源码实证）。
// ============================================================================

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';

const invokeMock = vi.fn();
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: unknown[] } = {
  agents: [], activeSessionId: undefined, messages: [],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: (...args: unknown[]) => invokeMock(...args) } }));

import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useComposerNoticeStore } from '../../../src/renderer/stores/composerNoticeStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

function agentOf(id: string, status: SwarmAgentState['status']): SwarmAgentState {
  return { id, name: id, role: id, status, iterations: 0, tokenUsage: { input: 0, output: 0 }, toolCalls: 0, filesChanged: [] };
}

describe('输入框上方那一格的优先级', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = [agentOf('researcher', 'running'), agentOf('writer', 'completed')];
    useComposerNoticeStore.setState({ notices: {} });
    useMemberViewStore.setState({ viewingMemberId: null });
    useComposerStore.setState({ selectedTeamRecipeId: null });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
  });
  afterEach(() => cleanup());

  it('没有确认卡时成员条完整展示', () => {
    render(<SessionMemberBar sessionId="session-1" />);
    expect(screen.getByTestId('session-member-bar')).toBeTruthy();
    expect(screen.queryByTestId('session-member-bar-collapsed')).toBeNull();
  });

  it('确认卡占位时成员条收成一行摘要，而不是整条消失', () => {
    render(<SessionMemberBar sessionId="session-1" />);
    act(() => { useComposerNoticeStore.getState().setNotice('team-recipe-draft', true); });

    const collapsed = screen.getByTestId('session-member-bar-collapsed');
    expect(collapsed).toBeTruthy();
    expect(screen.queryByTestId('session-member-bar')).toBeNull();
    // 摘要必须说清还剩几个人在干活，别只留个箭头
    expect(collapsed.textContent).toContain('1');
    expect(collapsed.textContent).toContain('工作中');
  });

  it('点摘要能就地展开完整成员条', () => {
    render(<SessionMemberBar sessionId="session-1" />);
    act(() => { useComposerNoticeStore.getState().setNotice('skill-draft', true); });

    fireEvent.click(screen.getByTestId('session-member-bar-collapsed'));
    expect(screen.getByTestId('session-member-bar')).toBeTruthy();
  });

  it('确认卡收掉后回到完整态，展开状态不黏到下一次', () => {
    render(<SessionMemberBar sessionId="session-1" />);
    act(() => { useComposerNoticeStore.getState().setNotice('role-draft', true); });
    fireEvent.click(screen.getByTestId('session-member-bar-collapsed'));
    act(() => { useComposerNoticeStore.getState().setNotice('role-draft', false); });
    expect(screen.getByTestId('session-member-bar')).toBeTruthy();

    act(() => { useComposerNoticeStore.getState().setNotice('role-draft', true); });
    expect(screen.getByTestId('session-member-bar-collapsed')).toBeTruthy();
  });

  it('没有成员时确认卡不会凭空造出一行摘要', () => {
    swarmState.agents = [];
    swarmState.activeSessionId = undefined;
    render(<SessionMemberBar sessionId="session-1" />);
    act(() => { useComposerNoticeStore.getState().setNotice('team-recipe-draft', true); });
    expect(screen.queryByTestId('session-member-bar-collapsed')).toBeNull();
    expect(screen.queryByTestId('session-member-bar')).toBeNull();
  });
});
