// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { createSwarmTraceStorageId, type SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const appState = {
  openWorkspacePreview: vi.fn(),
  openWorkbenchTab: vi.fn(),
  workbenchTabs: [] as string[],
};
const swarmState: {
  agents: SwarmAgentState[];
  activeSessionId: string | undefined;
  activeRunId?: string;
  activeTreeId?: string;
  lastEventAt?: number;
} = { agents: [], activeSessionId: undefined };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/appStore', () => {
  // 工厂在组件 import 时求值，早于 const 初始化：必须延迟解引用
  const useAppStore = (selector: (state: typeof appState) => unknown) => selector(appState);
  useAppStore.getState = () => appState;
  return { useAppStore };
});
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { SessionMemberBar, swarmRunAgentRecordToState } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useRightPanelTabsStore } from '../../../src/renderer/stores/rightPanelTabsStore';

const agents: SwarmRunAgentRecord[] = [
  { runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'completed', startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 5, costUsd: 0.002, error: null, failureCategory: null, filesChanged: [], dispatchedTask: '核对数据', finalOutput: `${'完整持久化产出'.repeat(40)} 收尾证据` },
  { runId: 'run-1', agentId: 'writer', name: '撰稿员', role: 'writer', status: 'completed', startTime: 2, endTime: 5_001, durationMs: 3_000, tokensIn: 56, tokensOut: 78, toolCalls: 6, costUsd: 0.003, error: null, failureCategory: null, filesChanged: [] },
];

const run: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'completed', coordinator: 'parallel', startedAt: 1, endedAt: 5_001, durationMs: 5_000,
  totalAgents: 2, completedCount: 2, failedCount: 0, totalCostUsd: 0.005, totalTokensIn: 68, totalTokensOut: 112, trigger: 'llm-spawn',
};

function mockLedger(detail: SwarmRunDetail, listItem: SwarmRunListItem = run): void {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([listItem]);
    if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detail);
    return Promise.resolve(null);
  });
}

const completedDetail: SwarmRunDetail = {
  run: { ...run, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
  agents,
  events: [],
};

describe('SessionMemberBar（折叠 chip）', () => {
  beforeEach(() => {
    swarmState.agents = [];
    swarmState.activeSessionId = undefined;
    swarmState.activeRunId = undefined;
    swarmState.activeTreeId = undefined;
    swarmState.lastEventAt = undefined;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    appState.openWorkbenchTab.mockReset();
    appState.workbenchTabs = [];
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useMemberViewStore.setState({ viewingMemberId: null });
    useBackgroundTaskStore.setState({ tasks: [] });
    useRightPanelTabsStore.setState({ expertsDismissedBySession: {} });
  });
  afterEach(() => cleanup());

  it('没有团队也没有预选时不渲染', async () => {
    render(<SessionMemberBar sessionId="session-1" />);
    await Promise.resolve();
    expect(screen.queryByTestId('session-member-bar-collapsed')).toBeNull();
  });

  it('空内存时回灌最近团队 run：全员完成文案 + 合并态 + 头像叠', async () => {
    mockLedger(completedDetail);

    render(<SessionMemberBar sessionId="session-1" />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    expect(chip.textContent).toContain('2 个代理已完成');
    // 两个代理全部完成且无冲突 → 尾部「合没合」报已合并
    expect(screen.getByTestId('member-bar-merge-state').textContent).toBe('改动已经合到一起了');
    // chip 左侧头像叠：专家行走 RoleInitialAvatar
    expect(screen.getByTestId('role-initial-avatar-researcher')).toBeTruthy();
    expect(screen.getByTestId('role-initial-avatar-writer')).toBeTruthy();
  });

  it('点 chip 直达右侧「专家」一级页签', async () => {
    mockLedger(completedDetail);

    render(<SessionMemberBar sessionId="session-1" />);
    fireEvent.click(await screen.findByTestId('session-member-bar-collapsed'));

    expect(appState.openWorkbenchTab).toHaveBeenCalledWith('experts', { source: 'user' });
    expect(appState.openWorkbenchTab).toHaveBeenCalledTimes(1);
    expect(appState.openWorkbenchTab).not.toHaveBeenCalledWith('overview', expect.anything());
    // 点 chip 不再进入某个成员的对话页（那是面板行的事）
    expect(useMemberViewStore.getState().viewingMemberId).toBeNull();
  });

  it('实时事件与持久化状态冲突时只展示账本/API 状态', async () => {
    swarmState.activeSessionId = 'session-1';
    swarmState.activeRunId = 'logical-run-1';
    swarmState.activeTreeId = 'tree-1';
    swarmState.lastEventAt = 10;
    swarmState.agents = agents.map((agent) => ({ ...swarmRunAgentRecordToState(agent), status: 'running' }));
    mockLedger(completedDetail);

    render(<SessionMemberBar sessionId="session-1" />);
    // stream 说 running、账本说 completed：chip 文案只信账本
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    await waitFor(() => expect(chip.textContent).toContain('2 个代理已完成'));
    expect(chip.textContent).not.toContain('工作中');
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL, {
      sessionId: 'session-1',
      runId: createSwarmTraceStorageId({
        sessionId: 'session-1',
        runId: 'logical-run-1',
        treeId: 'tree-1',
      }),
    });
  });

  it('有 working 代理时 chip 报「N 个代理工作中 · 第一个 working 行 当前一句」', async () => {
    const durableAgents: SwarmRunAgentRecord[] = [
      { ...agents[0], status: 'running', endTime: null, durationMs: null },
      agents[1],
    ];
    const detail: SwarmRunDetail = {
      run: { ...run, status: 'running', endedAt: null, completedCount: 1, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
      agents: durableAgents,
      events: [],
    };
    mockLedger(detail, { ...run, status: 'running' });

    render(<SessionMemberBar sessionId="session-1" />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    await waitFor(() => expect(chip.textContent).toContain('1 个代理工作中'));
    // 专家行没有真实工具步时回落「正在整理任务…」
    expect(chip.textContent).toContain('调研员 正在整理任务…');
    // 既没全完成也没冲突/卡住 → 不渲染合并态
    expect(screen.queryByTestId('member-bar-merge-state')).toBeNull();
  });

  it('多个 working 时当前一句取第一个 working 行', async () => {
    const durableAgents: SwarmRunAgentRecord[] = [
      { ...agents[0], status: 'running', endTime: null, durationMs: null },
      { ...agents[1], status: 'running', endTime: null, durationMs: null },
    ];
    const detail: SwarmRunDetail = {
      run: { ...run, status: 'running', endedAt: null, completedCount: 0, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
      agents: durableAgents,
      events: [],
    };
    mockLedger(detail, { ...run, status: 'running' });

    render(<SessionMemberBar sessionId="session-1" />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    await waitFor(() => expect(chip.textContent).toContain('2 个代理工作中 · 调研员'));
    expect(chip.textContent).not.toContain('撰稿员 正在整理任务…');
  });

  it('单个后台 Agent 也进入成员条，不要求组成两人 Team', async () => {
    const singleAgent = { ...agents[0], status: 'running' as const, endTime: null, durationMs: null };
    const detail: SwarmRunDetail = {
      run: {
        ...run,
        status: 'running',
        endedAt: null,
        totalAgents: 1,
        completedCount: 0,
        totalToolCalls: 0,
        parallelPeak: 1,
        errorSummary: null,
        aggregation: null,
        tags: [],
      },
      agents: [singleAgent],
      events: [],
    };
    mockLedger(detail, { ...run, status: 'running', totalAgents: 1 });

    render(<SessionMemberBar sessionId="session-1" />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    await waitFor(() => expect(chip.textContent).toContain('1 个代理工作中 · 调研员 正在整理任务…'));
  });

  // 预选是我们比 WorkBuddy 多做的一层：还没跑就先让用户看到这个团队由谁组成
  it('预选团队配方时 chip 报「N 个代理待命中」，不带合并态', async () => {
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
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    expect(chip.textContent).toContain('2 个代理待命中');
    // 待命态不假装在干活、也没有「合没合」可报
    expect(chip.textContent).not.toContain('工作中');
    expect(screen.queryByTestId('member-bar-merge-state')).toBeNull();
    // 待命名单的头像仍走角色三级回落
    expect(screen.getByTestId('role-initial-avatar-牧之')).toBeTruthy();
    expect(screen.getByTestId('role-initial-avatar-溯真')).toBeTruthy();
  });

  // 刀 1（N-NAMEDMATE）：成员条头像三级回落——真人头像资产 → 角色 icon（RoleIcon）→ 首字兜底
  it('待命名单头像：无资产有 icon 渲染 RoleIcon 不渲染首字，无 icon 才首字兜底', async () => {
    useAgentRegistryStore.setState({
      entries: [
        { id: 'researcher', name: '调研员', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '研究调研', icon: 'Microscope' },
        { id: 'writer', name: '撰稿员', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [] },
      ],
      isLoaded: true,
    });
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: '上线评审', description: '', category: 'automation', members: [{ roleId: 'researcher', taskTemplate: '调研 {topic}' }, { roleId: 'writer', taskTemplate: '写作 {topic}' }] }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });

    render(<SessionMemberBar sessionId="session-1" />);
    await screen.findByTestId('session-member-bar-collapsed');

    const iconAvatar = await screen.findByTestId('role-initial-avatar-researcher');
    expect(iconAvatar.querySelector('svg')).toBeTruthy();
    expect(iconAvatar.textContent).toBe('');

    const initialAvatar = screen.getByTestId('role-initial-avatar-writer');
    expect(initialAvatar.querySelector('svg')).toBeNull();
    expect(initialAvatar.textContent).toBe('W');
  });

  it('有真人头像资产的角色仍渲染头像图（资产档优先于 icon）', async () => {
    useAgentRegistryStore.setState({
      entries: [{ id: '牧之', name: '牧之', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '资深产品经理', icon: 'ClipboardList' }],
      isLoaded: true,
    });
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: '上线评审', description: '', category: 'automation', members: [{ roleId: '牧之', taskTemplate: '评审 {topic}' }] }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });

    render(<SessionMemberBar sessionId="session-1" />);
    await screen.findByTestId('session-member-bar-collapsed');

    const avatar = await screen.findByTestId('role-initial-avatar-牧之');
    expect(avatar.tagName).toBe('IMG');
  });

  it('把持久化成员记录映射为工作记录所需的实时状态', () => {
    expect(swarmRunAgentRecordToState(agents[0])).toMatchObject({
      id: 'researcher', name: '调研员', role: 'researcher', status: 'completed',
      tokenUsage: { input: 12, output: 34 }, toolCalls: 5, cost: 0.002, finalOutput: expect.stringContaining('收尾证据'),
    });
  });
});
