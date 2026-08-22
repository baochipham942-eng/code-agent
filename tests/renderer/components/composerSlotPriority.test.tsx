// @vitest-environment jsdom
// ============================================================================
// 输入框上方那一格的优先级：确认卡 > 成员条
// ----------------------------------------------------------------------------
// N-L6-AGENTVIEW 后：成员条常态就是一条折叠 chip，不再有「被确认卡挤压才折叠 /
// 点摘要就地展开」的两态逻辑——确认卡占位与否 chip 都长一样（一行摘要形态即常态）。
// 原来验证「就地展开 / 确认卡收掉后回完整态」的两个用例随行为一起删除。
// ============================================================================

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: unknown[] } = {
  agents: [], activeSessionId: undefined, messages: [],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useComposerNoticeStore } from '../../../src/renderer/stores/composerNoticeStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

function agentOf(id: string, status: SwarmAgentState['status']): SwarmAgentState {
  return { id, name: id, role: id, status, iterations: 0, tokenUsage: { input: 0, output: 0 }, toolCalls: 0, filesChanged: [] };
}

// 成员条状态以持久化账本为唯一真相源（竞品借鉴B），夹具喂 ledger API 而不是 stream
const ledgerAgents: SwarmRunAgentRecord[] = [
  { runId: 'run-1', agentId: 'researcher', name: 'researcher', role: 'researcher', status: 'running', startTime: 1, endTime: null, durationMs: null, tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0, error: null, failureCategory: null, filesChanged: [] },
  { runId: 'run-1', agentId: 'writer', name: 'writer', role: 'writer', status: 'completed', startTime: 2, endTime: 5_001, durationMs: 3_000, tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0, error: null, failureCategory: null, filesChanged: [] },
];
const ledgerRun: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'running', coordinator: 'parallel', startedAt: 1, endedAt: null, durationMs: null,
  totalAgents: 2, completedCount: 1, failedCount: 0, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, trigger: 'llm-spawn',
};
const ledgerDetail: SwarmRunDetail = {
  run: { ...ledgerRun, totalToolCalls: 0, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
  agents: ledgerAgents,
  events: [],
};

describe('输入框上方那一格的优先级', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(ledgerDetail);
      return Promise.resolve(null);
    });
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = [agentOf('researcher', 'running'), agentOf('writer', 'completed')];
    useComposerNoticeStore.setState({ notices: {}, inProgress: {} });
    useMemberViewStore.setState({ viewingMemberId: null });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useBackgroundTaskStore.setState({ tasks: [] });
  });
  afterEach(() => cleanup());

  it('没有确认卡时成员条就是一条折叠 chip（常态形态）', async () => {
    render(<SessionMemberBar sessionId="session-1" />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    // 一行摘要：说清几个人在干活 + 第一个 working 行的当前一句
    expect(chip.textContent).toContain('1 个代理工作中');
  });

  it('确认卡占位时 chip 仍渲染同一条，不整条消失也不换形态', async () => {
    render(<SessionMemberBar sessionId="session-1" />);
    const before = await screen.findByTestId('session-member-bar-collapsed');
    act(() => { useComposerNoticeStore.getState().setNotice('team-recipe-draft', true); });

    const chip = screen.getByTestId('session-member-bar-collapsed');
    expect(chip).toBeTruthy();
    // 确认卡占位前后是同一条 chip，文案不变
    expect(chip.textContent).toBe(before.textContent);
    expect(chip.textContent).toContain('1 个代理工作中');
  });

  it('没有成员时确认卡不会凭空造出一行摘要', async () => {
    swarmState.agents = [];
    swarmState.activeSessionId = undefined;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    render(<SessionMemberBar sessionId="session-1" />);
    act(() => { useComposerNoticeStore.getState().setNotice('team-recipe-draft', true); });
    await Promise.resolve();
    expect(screen.queryByTestId('session-member-bar-collapsed')).toBeNull();
  });
});
