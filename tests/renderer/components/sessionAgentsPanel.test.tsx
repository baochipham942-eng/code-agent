// @vitest-environment jsdom
// ============================================================================
// SessionAgentsPanel - 右侧「本会话的代理」面板（N-L6-AGENTVIEW S2）
// 成员条 pill 展开态搬进面板的断言（停止全部 / token / standby × / 行级停）都落在这里。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AgentTreeNode, AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const appState = { setWorkbenchCollapsed: vi.fn() };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/appStore', () => {
  // 工厂在组件 import 时求值，早于 const 初始化：必须延迟解引用
  const useAppStore = (selector: (state: typeof appState) => unknown) => selector(appState);
  useAppStore.getState = () => appState;
  return { useAppStore };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const record = (overrides: Partial<SwarmRunAgentRecord>): SwarmRunAgentRecord => ({
  runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'completed',
  startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 5, costUsd: 0.002,
  error: null, failureCategory: null, filesChanged: [], ...overrides,
});

const ledgerRun: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'completed', coordinator: 'parallel', startedAt: 1, endedAt: 5_001, durationMs: 5_000,
  totalAgents: 2, completedCount: 2, failedCount: 0, totalCostUsd: 0.005, totalTokensIn: 68, totalTokensOut: 112, trigger: 'llm-spawn',
};

function mockLedger(agents: SwarmRunAgentRecord[], runOverrides: Partial<SwarmRunListItem> = {}): void {
  const item = { ...ledgerRun, ...runOverrides };
  const detail: SwarmRunDetail = {
    run: { ...item, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
    agents,
    events: [],
  };
  invokeMock.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([item]);
    if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detail);
    return Promise.resolve(null);
  });
}

function treeNode(overrides: Partial<AgentTreeNode>): AgentTreeNode {
  return {
    id: 'agent-9', role: '审阅代理', status: 'running', statusLabel: '正在处理',
    children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [],
    sources: ['spawnGuard'], ...overrides,
  };
}

function snapshotOf(nodes: AgentTreeNode[], conflicts: AgentTreeSnapshot['summary']['ownershipConflicts'] = []): AgentTreeSnapshot {
  return {
    generatedAt: 1,
    roots: nodes,
    nodes,
    summary: {
      total: nodes.length, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0,
      withWorktree: 0, ownershipConflicts: conflicts,
    },
  };
}

function mockTree(snapshot: AgentTreeSnapshot | null): void {
  invokeDomainMock.mockImplementation((domain: unknown, action: unknown) => {
    if (domain === IPC_DOMAINS.AGENT && action === 'getTree') return Promise.resolve(snapshot);
    return Promise.resolve(null);
  });
}

function backgroundTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1', sessionId: 'session-1', source: 'delegate_task', title: '核对发布清单',
    status: 'running', createdAt: 1, updatedAt: 2, events: [], outputRefs: [], ...overrides,
  };
}

describe('SessionAgentsPanel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    appState.setWorkbenchCollapsed.mockReset();
    useSwarmStore.setState({ activeSessionId: undefined, activeRunId: undefined, activeTreeId: undefined, lastEventAt: undefined, eventLog: [] });
    useSessionStore.setState({ sessions: [], currentSessionId: 'session-1' });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useMemberViewStore.setState({ viewingMemberId: null });
    useVoiceCallStore.getState().reset();
    useBackgroundTaskStore.setState({ tasks: [] });
    (window as unknown as { domainAPI?: unknown }).domainAPI = undefined;
  });
  afterEach(() => cleanup());

  it('没有代理时给空态', async () => {
    render(<SessionAgentsPanel />);
    await Promise.resolve();
    expect(screen.getByTestId('agents-panel-empty').textContent).toBe('这个会话还没有代理');
  });

  it('账本成员铺成专家行，点行进该成员的对话视图', async () => {
    mockLedger([record({}), record({ agentId: 'writer', name: '撰稿员', role: 'writer' })]);

    render(<SessionAgentsPanel />);
    await screen.findByTestId('agents-panel-row-researcher');
    expect(screen.getByTestId('agents-panel-row-writer')).toBeTruthy();
    expect(screen.getByTestId('agents-panel-status-researcher').textContent).toBe('完成');
    // 两个代理全部完成 → 顶部「合没合」报已合并
    expect(screen.getByTestId('agents-panel-merge-state').textContent).toBe('2 个代理的改动已经合到一起了');

    fireEvent.click(screen.getByTestId('agents-panel-open-researcher'));
    expect(useMemberViewStore.getState().viewingMemberId).toBe('researcher');
  });

  it('行状态文案：工作中 / 失败（带原因）/ 卡住了在等你', async () => {
    mockLedger([record({ status: 'running', endTime: null, durationMs: null })]);
    mockTree(snapshotOf([
      treeNode({ id: 'agent-failed', role: '失败代理', status: 'failed', statusLabel: '遇到问题', failureReason: '可用预算已经用完' }),
      treeNode({ id: 'agent-blocked', role: '阻塞代理', status: 'blocked', statusLabel: '被阻塞' }),
    ]));

    render(<SessionAgentsPanel />);
    await screen.findByTestId('agents-panel-row-researcher');
    expect(screen.getByTestId('agents-panel-status-researcher').textContent).toBe('工作中');
    expect(screen.getByTestId('agents-panel-status-agent-failed').textContent).toBe('失败：可用预算已经用完');
    expect(screen.getByTestId('agents-panel-status-agent-blocked').textContent).toBe('卡住了在等你');
    // 有 waiting 行 → 顶部报「卡住了」
    expect(screen.getByTestId('agents-panel-merge-state').textContent).toBe('一个代理卡住了在等你');
  });

  it('delegate_task 后台任务成 kind task 行，带「后台」badge', async () => {
    useBackgroundTaskStore.setState({ tasks: [backgroundTask({})] });

    render(<SessionAgentsPanel />);
    const row = await screen.findByTestId('agents-panel-row-task-1');
    expect(row.textContent).toContain('核对发布清单');
    expect(row.textContent).toContain('后台');
    expect(screen.getByTestId('agents-panel-status-task-1').textContent).toBe('工作中');
  });

  it('行级停：专家行走 swarm:cancel-agent（带 activeRunId）', async () => {
    useSwarmStore.setState({ activeRunId: 'logical-run-1' });
    mockLedger([record({ status: 'running', endTime: null, durationMs: null })]);
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([{ ...ledgerRun, status: 'running' }]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve({
          run: { ...ledgerRun, status: 'running', endedAt: null, totalToolCalls: 0, parallelPeak: 1, errorSummary: null, aggregation: null, tags: [] },
          agents: [record({ status: 'running', endTime: null, durationMs: null })],
          events: [],
        } satisfies SwarmRunDetail);
      }
      if (channel === IPC_CHANNELS.SWARM_CANCEL_AGENT) return Promise.resolve(true);
      return Promise.resolve(null);
    });

    render(<SessionAgentsPanel />);
    fireEvent.click(await screen.findByTestId('agents-panel-stop-researcher'));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_CANCEL_AGENT, {
      sessionId: 'session-1',
      runId: 'logical-run-1',
      agentId: 'researcher',
    }));
  });

  it('行级停：普通代理走 agent.closeAgent，后台任务走 task.cancelBackgroundTask', async () => {
    const domainApiInvoke = vi.fn().mockResolvedValue(true);
    (window as unknown as { domainAPI?: unknown }).domainAPI = { invoke: domainApiInvoke };
    mockTree(snapshotOf([treeNode({})]));
    useBackgroundTaskStore.setState({ tasks: [backgroundTask({})] });

    render(<SessionAgentsPanel />);
    fireEvent.click(await screen.findByTestId('agents-panel-stop-agent-9'));
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'closeAgent', {
      agentId: 'agent-9',
      sessionId: 'session-1',
    }));

    fireEvent.click(screen.getByTestId('agents-panel-stop-task-1'));
    await waitFor(() => expect(domainApiInvoke).toHaveBeenCalledWith(IPC_DOMAINS.TASK, 'cancelBackgroundTask', {
      taskId: 'task-1',
    }));
  });

  it('停止全部对所有可停行走各自通道', async () => {
    useSwarmStore.setState({ activeRunId: 'logical-run-1' });
    const running = record({ status: 'running', endTime: null, durationMs: null });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([{ ...ledgerRun, status: 'running' }]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve({
          run: { ...ledgerRun, status: 'running', endedAt: null, totalToolCalls: 0, parallelPeak: 1, errorSummary: null, aggregation: null, tags: [] },
          agents: [running],
          events: [],
        } satisfies SwarmRunDetail);
      }
      if (channel === IPC_CHANNELS.SWARM_CANCEL_AGENT) return Promise.resolve(true);
      return Promise.resolve(null);
    });
    mockTree(snapshotOf([treeNode({})]));

    render(<SessionAgentsPanel />);
    fireEvent.click(await screen.findByTestId('agents-panel-stop-all'));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_CANCEL_AGENT, {
      sessionId: 'session-1', runId: 'logical-run-1', agentId: 'researcher',
    }));
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'closeAgent', {
      agentId: 'agent-9', sessionId: 'session-1',
    }));
  });

  it('无可停行时不渲染停止全部', async () => {
    mockLedger([record({}), record({ agentId: 'writer', name: '撰稿员', role: 'writer' })]);

    render(<SessionAgentsPanel />);
    await screen.findByTestId('agents-panel-row-researcher');
    expect(screen.queryByTestId('agents-panel-stop-all')).toBeNull();
  });

  it('关闭按钮收起右栏', async () => {
    render(<SessionAgentsPanel />);
    fireEvent.click(screen.getByTestId('agents-panel-close'));
    expect(appState.setWorkbenchCollapsed).toHaveBeenCalledWith(true);
  });

  it('所有权冲突铺冲突列表 + 顶部报冲突态', async () => {
    mockLedger([record({}), record({ agentId: 'writer', name: '撰稿员', role: 'writer' })]);
    mockTree(snapshotOf([], [{ path: 'src/host/agent/foo.ts', ownerAgentId: 'researcher', requesterAgentId: 'writer' }]));

    render(<SessionAgentsPanel />);
    await screen.findByTestId('agents-panel-row-researcher');
    expect(screen.getByTestId('agents-panel-merge-state').textContent).toBe('有 1 处改到了同一个地方，需要你定用哪个 →');
    const conflicts = screen.getByTestId('agents-panel-conflicts');
    expect(conflicts.textContent).toContain('调研员 和 撰稿员 都改了 foo.ts');
  });

  // 从成员条搬来：standby 成员的 × 排除（原来在 pill 上）
  it('待命成员行的 × 把该成员排除出本次预选，配方预选本身保留', async () => {
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: '上线评审', description: '', category: 'automation', lead: { roleId: '牧之', briefTemplate: '汇总 {topic}' }, members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }, { roleId: '青禾', taskTemplate: '写作 {topic}' }] }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });

    render(<SessionAgentsPanel />);
    fireEvent.click(await screen.findByTestId('member-standby-remove-青禾'));

    await waitFor(() => expect(screen.queryByTestId('member-standby-remove-青禾')).toBeNull());
    expect(useComposerStore.getState().standbyExcludedMemberKeys).toEqual(['青禾']);
    expect(useComposerStore.getState().selectedTeamRecipeId).toBe('r1');
    expect(screen.getByTestId('member-standby-remove-牧之')).toBeTruthy();
    expect(screen.getByTestId('member-standby-remove-溯真')).toBeTruthy();
  });

  it('待命成员 × 到最后一个不剩时整团取消预选', async () => {
    useTeamRecipeStore.setState({
      recipes: [{ id: 'r1', name: '上线评审', description: '', category: 'automation', lead: { roleId: '牧之', briefTemplate: '汇总 {topic}' }, members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }] }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'r1' });

    render(<SessionAgentsPanel />);
    fireEvent.click(await screen.findByTestId('member-standby-remove-牧之'));
    fireEvent.click(await screen.findByTestId('member-standby-remove-溯真'));

    await waitFor(() => expect(screen.getByTestId('agents-panel-empty')).toBeTruthy());
    expect(useComposerStore.getState().selectedTeamRecipeId).toBeNull();
    expect(useComposerStore.getState().standbyExcludedMemberKeys).toEqual([]);
  });

  it('讨论流事件非空时出现折叠开关，展开内嵌 DiscussionStream', async () => {
    mockLedger([record({})]);
    useSwarmStore.setState({
      eventLog: [{ id: 'e1', type: 'swarm:agent:message', timestamp: 1, title: '调研员发言', summary: '口径对完了', tone: 'neutral', agentId: 'researcher' }],
    });

    render(<SessionAgentsPanel />);
    const toggle = await screen.findByTestId('agents-panel-events-toggle');
    expect(toggle.textContent).toContain('讨论流 · 1 条');
    expect(screen.queryByTestId('agents-panel-events')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId('agents-panel-events')).toBeTruthy();
  });

  it('durable run 有数据时底部给 token 与耗时', async () => {
    mockLedger([record({})], { totalTokensIn: 1500, totalTokensOut: 500, startedAt: 1, endedAt: 5_001 });

    render(<SessionAgentsPanel />);
    await screen.findByTestId('agents-panel-row-researcher');
    const usage = screen.getByTestId('agents-panel-usage');
    expect(usage.textContent).toContain('2.0K');
    expect(usage.textContent).toContain('5 秒');
  });
});
