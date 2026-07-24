// @vitest-environment jsdom
// ============================================================================
// 点成员 → 聊天区换成他的对话页；人只跟团长说话，成员页是只读的
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord } from '../../../src/shared/contract/swarmTrace';

const invokeMock = vi.fn();
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: Array<{ id: string; from: string; to: string; content: string; timestamp: number; messageType: string }> } = {
  agents: [], activeSessionId: undefined, messages: [],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: (...args: unknown[]) => invokeMock(...args) } }));

import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { MemberConversationView } from '../../../src/renderer/components/features/expert/MemberConversationView';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

const record: SwarmRunAgentRecord = {
  runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'completed',
  startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 5, costUsd: 0.002,
  error: null, failureCategory: null, filesChanged: [], dispatchedTask: '核对第三方数据口径', finalOutput: '三处口径不一致，已列明',
};

function agentOf(overrides: Partial<SwarmAgentState> = {}): SwarmAgentState {
  return {
    id: record.agentId, name: record.name, role: record.role, status: 'completed',
    startTime: record.startTime ?? undefined, endTime: record.endTime ?? undefined, iterations: 0,
    tokenUsage: { input: record.tokensIn, output: record.tokensOut }, toolCalls: record.toolCalls,
    cost: record.costUsd, dispatchedTask: record.dispatchedTask, finalOutput: record.finalOutput,
    filesChanged: [], ...overrides,
  };
}

describe('成员对话页', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = [agentOf(), agentOf({ id: 'writer', name: '撰稿员', role: 'writer', dispatchedTask: '起草', finalOutput: '初稿' })];
    swarmState.messages = [];
    useMemberViewStore.setState({ viewingMemberId: null });
    useComposerStore.setState({ selectedTeamRecipeId: null });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [{ id: 'researcher', name: '调研员', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '行业研究员' }], isLoaded: true });
  });
  afterEach(() => cleanup());

  it('点成员进入他的对话页，展示下发任务和产出', async () => {
    render(<><SessionMemberBar sessionId="session-1" /><MemberConversationView sessionId="session-1" /></>);
    expect(screen.queryByTestId('member-conversation-view')).toBeNull();

    fireEvent.click(screen.getByTestId('member-pill-researcher'));
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());
    expect(screen.getByTestId('member-dispatched-task').textContent).toContain('核对第三方数据口径');
    expect(screen.getByTestId('member-final-output').textContent).toContain('三处口径不一致');
    // 只显示这一位，不串到别人
    expect(screen.getByTestId('member-conversation-view').textContent).not.toContain('初稿');
  });

  it('再点同一个成员回主会话，点主会话 pill 也回', async () => {
    render(<><SessionMemberBar sessionId="session-1" /><MemberConversationView sessionId="session-1" /></>);
    fireEvent.click(screen.getByTestId('member-pill-researcher'));
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());

    fireEvent.click(screen.getByTestId('member-pill-researcher'));
    await waitFor(() => expect(screen.queryByTestId('member-conversation-view')).toBeNull());

    fireEvent.click(screen.getByTestId('member-pill-researcher'));
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());
    fireEvent.click(screen.getByTestId('member-pill-leader'));
    await waitFor(() => expect(screen.queryByTestId('member-conversation-view')).toBeNull());
  });

  it('运行中的过程消息只取与这位成员相关的', async () => {
    swarmState.messages = [
      { id: 'm1', from: 'researcher', to: 'lead', content: '口径对完了', timestamp: 1, messageType: 'result' },
      { id: 'm2', from: 'writer', to: 'lead', content: '别人的消息', timestamp: 2, messageType: 'result' },
    ];
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-process-messages')).toBeTruthy());
    expect(screen.getByTestId('member-process-messages').textContent).toContain('口径对完了');
    expect(screen.getByTestId('member-process-messages').textContent).not.toContain('别人的消息');
  });

  it('待命态的成员点不进去（还没有对话可看）', async () => {
    swarmState.agents = [];
    swarmState.activeSessionId = undefined;
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: '上线评审', description: '', category: 'automation', members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }] }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });

    render(<><SessionMemberBar sessionId="session-1" /><MemberConversationView sessionId="session-1" /></>);
    fireEvent.click(screen.getByTestId('member-pill-溯真'));
    await Promise.resolve();
    expect(useMemberViewStore.getState().viewingMemberId).toBeNull();
    expect(screen.queryByTestId('member-conversation-view')).toBeNull();
  });
});
