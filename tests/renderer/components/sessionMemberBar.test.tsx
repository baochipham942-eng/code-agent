// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const appState = { openWorkspacePreview: vi.fn() };
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined } = { agents: [], activeSessionId: undefined };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
// 工厂在组件 import 时求值，早于 const 初始化：必须延迟解引用
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: (...args: unknown[]) => invokeMock(...args) } }));

import { SessionMemberBar, swarmRunAgentRecordToState } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

const agents: SwarmRunAgentRecord[] = [
  { runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'completed', startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 5, costUsd: 0.002, error: null, failureCategory: null, filesChanged: [], dispatchedTask: '核对数据', finalOutput: `${'完整持久化产出'.repeat(40)} 收尾证据` },
  { runId: 'run-1', agentId: 'writer', name: '撰稿员', role: 'writer', status: 'completed', startTime: 2, endTime: 5_001, durationMs: 3_000, tokensIn: 56, tokensOut: 78, toolCalls: 6, costUsd: 0.003, error: null, failureCategory: null, filesChanged: [] },
];

const run: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'completed', coordinator: 'parallel', startedAt: 1, endedAt: 5_001, durationMs: 5_000,
  totalAgents: 2, completedCount: 2, failedCount: 0, totalCostUsd: 0.005, totalTokensIn: 68, totalTokensOut: 112, trigger: 'llm-spawn',
};

describe('SessionMemberBar', () => {
  beforeEach(() => {
    swarmState.agents = [];
    swarmState.activeSessionId = undefined;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    useComposerStore.setState({ selectedTeamRecipeId: null });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
  });
  afterEach(() => cleanup());

  it('没有团队也没有预选时不渲染', async () => {
    render(<SessionMemberBar sessionId="session-1" />);
    await Promise.resolve();
    expect(screen.queryByTestId('session-member-bar')).toBeNull();
  });

  it('空内存时回灌最近团队 run，点成员打开完整工作记录', async () => {
    const detail: SwarmRunDetail = { run: { ...run, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] }, agents, events: [] };
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([run]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detail);
      return Promise.resolve(null);
    });

    render(<SessionMemberBar sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('session-member-bar')).toBeTruthy());
    expect(screen.getByTestId('member-pill-leader')).toBeTruthy();
    expect(screen.getByTestId('member-pill-researcher')).toBeTruthy();

    fireEvent.click(screen.getByTestId('member-pill-researcher'));
    expect(await screen.findByTestId('agent-work-record')).toBeTruthy();
    expect(screen.getByTestId('agent-work-output').textContent).toContain('收尾证据');
  });

  it('实时团队优先，不读取持久化 run', async () => {
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = agents.map(swarmRunAgentRecordToState);

    render(<SessionMemberBar sessionId="session-1" />);
    expect(screen.getByTestId('session-member-bar')).toBeTruthy();
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalledWith(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, expect.anything());
  });

  it('运行中的成员带转圈徽标，跑完的带对勾', async () => {
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = [
      { ...swarmRunAgentRecordToState(agents[0]), status: 'running' },
      swarmRunAgentRecordToState(agents[1]),
    ];

    render(<SessionMemberBar sessionId="session-1" />);
    expect(screen.getByTestId('member-status-running')).toBeTruthy();
    expect(screen.getByTestId('member-status-completed')).toBeTruthy();
  });

  // 预选是我们比 WorkBuddy 多做的一层：还没跑就先让用户看到这个团队由谁组成
  it('预选团队配方时铺出灰态名单（主理人在前）且不带状态徽标', async () => {
    useAgentRegistryStore.setState({
      entries: [{ id: '牧之', name: '牧之', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '资深产品经理' }],
      isLoaded: true,
    });
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: '上线评审', description: '', category: 'automation', lead: { roleId: '牧之', briefTemplate: '汇总 {topic}' }, members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }] }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });

    render(<SessionMemberBar sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('session-member-bar')).toBeTruthy());
    expect(screen.getByTestId('member-pill-牧之')).toBeTruthy();
    expect(screen.getByTestId('member-pill-溯真')).toBeTruthy();
    // 职业接上了 H1 铺的数据
    expect(screen.getByTestId('session-member-bar').textContent).toContain('资深产品经理');
    // 待命态不该假装在干活
    expect(screen.queryByTestId('member-status-running')).toBeNull();
    expect(screen.queryByTestId('member-status-completed')).toBeNull();
    // 还没跑，没有「主会话」可回
    expect(screen.queryByTestId('member-pill-leader')).toBeNull();
  });

  it('把持久化成员记录映射为工作记录所需的实时状态', () => {
    expect(swarmRunAgentRecordToState(agents[0])).toMatchObject({
      id: 'researcher', name: '调研员', role: 'researcher', status: 'completed',
      tokenUsage: { input: 12, output: 34 }, toolCalls: 5, cost: 0.002, finalOutput: expect.stringContaining('收尾证据'),
    });
  });
});
