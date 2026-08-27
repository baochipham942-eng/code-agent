// @vitest-environment jsdom
// ============================================================================
// 点成员 → 聊天区换成他的对话页；人只跟团长说话，成员页是只读的
// N-L6-AGENTVIEW S3 后：入口从成员条 pill 搬到「本会话的代理」面板行
// （agents-panel-open-*，接线在 sessionAgentsPanel.test.tsx 断言），本文件直接
// set viewingMemberId；回主会话走顶部「← 返回主会话」（member-view-back）。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AgentTreeNode, AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: Array<{ id: string; from: string; to: string; content: string; timestamp: number; messageType: string }> } = {
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

import { MemberConversationView } from '../../../src/renderer/components/features/expert/MemberConversationView';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const record: SwarmRunAgentRecord = {
  runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'completed',
  startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 5, costUsd: 0.002,
  error: null, failureCategory: null, filesChanged: [], dispatchedTask: '核对第三方数据口径', finalOutput: '三处口径不一致，已列明',
};

// 成员页状态以持久化账本为唯一真相源（竞品借鉴B），夹具喂 ledger API
const writerRecord: SwarmRunAgentRecord = {
  ...record, agentId: 'writer', name: '撰稿员', role: 'writer', dispatchedTask: '起草', finalOutput: '初稿',
};
const ledgerRun: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'completed', coordinator: 'parallel', startedAt: 1, endedAt: 5_001, durationMs: 5_000,
  totalAgents: 2, completedCount: 2, failedCount: 0, totalCostUsd: 0.005, totalTokensIn: 68, totalTokensOut: 112, trigger: 'llm-spawn',
};
const ledgerDetail: SwarmRunDetail = {
  run: { ...ledgerRun, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
  agents: [record, writerRecord],
  events: [],
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

function treeSnapshot(node: AgentTreeNode): AgentTreeSnapshot {
  return {
    generatedAt: 1,
    roots: [node],
    nodes: [node],
    summary: { total: 1, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
  };
}

describe('成员对话页', () => {
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
    swarmState.agents = [agentOf(), agentOf({ id: 'writer', name: '撰稿员', role: 'writer', dispatchedTask: '起草', finalOutput: '初稿' })];
    swarmState.messages = [];
    useMemberViewStore.setState({ viewingMemberId: null });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [{ id: 'researcher', name: '调研员', description: '', source: 'builtin', modelTier: 'balanced', readonly: true, tools: [], profession: '行业研究员' }], isLoaded: true });
    useBackgroundTaskStore.setState({ tasks: [] });
  });
  afterEach(() => cleanup());

  it('进入成员对话页，展示下发任务和产出', async () => {
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());
    expect(screen.getByTestId('member-dispatched-task').textContent).toContain('核对第三方数据口径');
    expect(screen.getByTestId('member-final-output').textContent).toContain('三处口径不一致');
    // 只显示这一位，不串到别人
    expect(screen.getByTestId('member-conversation-view').textContent).not.toContain('初稿');
  });

  it('点顶部「← 返回主会话」回主会话', async () => {
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());

    const back = screen.getByTestId('member-view-back');
    expect(back.textContent).toContain(zh.expert.workRecord.backToChat);
    fireEvent.click(back);
    expect(useMemberViewStore.getState().viewingMemberId).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('member-conversation-view')).toBeNull());
  });

  it('viewingMemberId 在成员/agentTree/后台任务里都找不到时不渲染', async () => {
    useMemberViewStore.setState({ viewingMemberId: 'ghost-agent' });

    render(<MemberConversationView sessionId="session-1" />);
    await Promise.resolve();
    expect(screen.queryByTestId('member-conversation-view')).toBeNull();
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

  // D2（2026-08-05）：成员视图此前只有「任务 + 产出 + 聚合计数」，中间全是黑箱。
  it('滚动显示最近动作：工具名过人话化，最新的在最上面', async () => {
    swarmState.agents = [
      agentOf({
        status: 'running',
        contextSnapshot: {
          currentTokens: 100, maxTokens: 1000, usagePercent: 10, messageCount: 3,
          warningLevel: 'normal', lastUpdated: 1, attachments: [], previews: [], truncatedMessages: 0,
          tools: ['Read', 'Bash'],
        },
      }),
    ];
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-recent-actions')).toBeTruthy());

    const actions = screen.getAllByTestId('member-recent-action');
    expect(actions).toHaveLength(2);
    // 倒序：最后用的工具排最前；且渲染的是人话不是裸工具名
    expect(actions[0].textContent).toBe(zh.toolStepHumanize.bashFallback);
    expect(actions[1].textContent).toBe(zh.toolStepHumanize.readFallback);
    expect(screen.getByTestId('member-recent-actions').textContent).not.toContain('Bash');

    // S3：当前动作置顶高亮 = 最近一条动作
    expect(screen.getByTestId('member-current-action').textContent).toBe(zh.toolStepHumanize.bashFallback);
  });

  it('还没动手时给空态文案，不留一个空壳区块', async () => {
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-recent-actions')).toBeTruthy());
    expect(screen.getByTestId('member-recent-actions').textContent).toContain(zh.expert.memberBar.noRecentActions);
    expect(screen.queryAllByTestId('member-recent-action')).toHaveLength(0);
    // 没有最近动作就不渲染置顶高亮块
    expect(screen.queryByTestId('member-current-action')).toBeNull();
  });

  it('运行轨迹消费账本已落的生命周期事件，只取本成员 + run 级', async () => {
    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve({
          ...ledgerDetail,
          events: [
            { id: 1, runId: 'run-1', seq: 1, timestamp: 1_000, eventType: 'swarm:started', agentId: null, level: 'info', title: '组队启动', summary: '' },
            { id: 2, runId: 'run-1', seq: 2, timestamp: 2_000, eventType: 'swarm:agent:updated', agentId: 'researcher', level: 'info', title: '调研员开始工作', summary: '正在核对口径' },
            { id: 3, runId: 'run-1', seq: 3, timestamp: 3_000, eventType: 'swarm:agent:updated', agentId: 'writer', level: 'info', title: '撰稿员开始工作', summary: '别人的轨迹' },
          ],
        });
      }
      return Promise.resolve(null);
    });
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-run-trail')).toBeTruthy());

    const trail = screen.getByTestId('member-run-trail');
    expect(trail.textContent).toContain('调研员开始工作');
    expect(trail.textContent).toContain('正在核对口径');
    expect(trail.textContent).toContain('组队启动');
    expect(trail.textContent).not.toContain('别人的轨迹');
    // 倒序：最新一条排最前
    expect(screen.getAllByTestId('member-run-trail-event')[0].textContent).toContain('调研员开始工作');
  });

  // ── S3：普通代理（非 Team 成员）视图 ──

  it('普通代理按 agentTree 节点渲染：任务 / 产出 / 用量 / 当前动作', async () => {
    // 账本里没有这个代理（不是 Team 成员）
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    const node: AgentTreeNode = {
      id: 'agent-9', role: '审阅代理', status: 'running', statusLabel: '正在处理',
      task: '审阅改动', progress: '审阅完成：两处要改',
      lastToolStep: { tool: 'Read', target: '/repo/a.ts', at: 1 },
      children: [], worktreeState: { status: 'none' },
      budgetSummary: { tokensUsed: 1200, toolCalls: 3, costUsd: 0.01 },
      evidenceRefs: [], sources: ['spawnGuard'],
    };
    invokeDomainMock.mockImplementation((domain: unknown, action: unknown) => {
      if (domain === IPC_DOMAINS.AGENT && action === 'getTree') return Promise.resolve(treeSnapshot(node));
      return Promise.resolve(null);
    });
    useMemberViewStore.setState({ viewingMemberId: 'agent-9' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());
    expect(screen.getByTestId('member-dispatched-task').textContent).toContain('审阅改动');
    expect(screen.getByTestId('member-final-output').textContent).toContain('审阅完成：两处要改');
    const usage = screen.getByTestId('member-usage');
    expect(usage.textContent).toContain('3 次工具调用');
    expect(usage.textContent).toContain('1200');
    // 当前动作置顶高亮恒渲染（普通代理 = describeLastToolStep 一句）
    expect(screen.getByTestId('member-current-action').textContent).toContain('读取了 /repo/a.ts');
    // 普通代理视图也有返回主会话
    expect(screen.getByTestId('member-view-back')).toBeTruthy();
  });

  it('普通代理按 delegate_task 后台任务渲染：标题 / 摘要 / 产出引用 / 耗时', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    const task: Task = {
      id: 'task-7', sessionId: 'session-1', source: 'delegate_task', title: '核对发布清单',
      summary: '清单已核对', status: 'completed', createdAt: 1, updatedAt: 2, durationMs: 5_000,
      events: [],
      outputRefs: [{ id: 'ref-1', taskId: 'task-7', type: 'file', label: '发布清单.md', createdAt: 2 }],
    };
    useBackgroundTaskStore.setState({ tasks: [task] });
    useMemberViewStore.setState({ viewingMemberId: 'task-7' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-conversation-view')).toBeTruthy());
    expect(screen.getByTestId('member-dispatched-task').textContent).toContain('核对发布清单');
    expect(screen.getByTestId('member-final-output').textContent).toContain('清单已核对');
    expect(screen.getByTestId('member-output-ref').textContent).toContain('发布清单.md');
    expect(screen.getByTestId('member-usage').textContent).toContain('5s');
    // 没有工具步时不渲染虚构的当前动作
    expect(screen.queryByTestId('member-current-action')).toBeNull();
  });
});
