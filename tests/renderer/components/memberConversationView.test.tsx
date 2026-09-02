// @vitest-environment jsdom
// ============================================================================
// 点成员 → 聊天区换成他的对话页；人只跟团长说话，成员页是只读的
// N-L6-AGENTVIEW S3 后：入口从成员条 pill 搬到「本会话的代理」面板行
// （agents-panel-open-*，接线在 sessionAgentsPanel.test.tsx 断言），本文件直接
// set viewingMemberId；回主会话走顶部「← 返回主会话」（member-view-back）。
// N-SUBAGENT-INPUT（09-02）：成员页不再只读——底部输入条 Enter 补话 / ⌘Enter 改道，
// 顶栏「停掉这位成员」；回执三态；已收工不给输入框。团队面板旧 1:1 输入框的三条契约
// （没送到留草稿并报原因 / 送到没记下清草稿不催重发 / 切换成员清草稿丢旧结果）搬到这里。
// ============================================================================

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

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

  // ── N-SUBAGENT-INPUT：给成员补话 / 改道 / 停掉 ──

  function runningMember() {
    swarmState.agents = [agentOf({ status: 'running' })];
    // 账本里也是 running（成员状态以账本为真相源）
    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([{ ...ledgerRun, status: 'running', endedAt: null }]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve({ ...ledgerDetail, agents: [{ ...record, status: 'running', endTime: null }, writerRecord] });
      }
      return Promise.resolve(null);
    });
    useSessionStore.setState({ currentSessionId: 'session-1', messages: [] });
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });
  }

  it('运行中的成员：Enter 补话走 sendMemberInput（supplement），回执「已送到」，草稿清空，主对话落一条记录', async () => {
    runningMember();
    invokeDomainMock.mockResolvedValue({ outcome: 'delivered', effect: 'next_step', persisted: true });

    render(<MemberConversationView sessionId="session-1" />);
    const input = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    expect(input.placeholder).toBe(zh.expert.memberBar.inputPlaceholder.replace('{name}', '行业研究员'));
    fireEvent.change(input, { target: { value: '顺便把页码加上' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('delivered'));
    expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'sendMemberInput', expect.objectContaining({
      sessionId: 'session-1', runId: 'run-1', memberId: 'researcher', kind: 'expert', message: '顺便把页码加上', mode: 'supplement',
    }));
    expect(screen.getByTestId('member-input-receipt').textContent).toContain(zh.expert.memberBar.receiptDelivered);
    expect(input.value).toBe('');
    const recorded = useSessionStore.getState().messages.find((message) => message.content === '顺便把页码加上');
    expect(recorded?.metadata?.memberInput).toEqual({ memberId: 'researcher', memberName: '行业研究员', mode: 'supplement' });
  });

  it('⌘Enter 改道：mode=redirect，回执说明手头这步做完才改', async () => {
    runningMember();
    invokeDomainMock.mockResolvedValue({ outcome: 'delivered', effect: 'next_step', persisted: true });

    render(<MemberConversationView sessionId="session-1" />);
    const input = await screen.findByTestId('member-input');
    fireEvent.change(input, { target: { value: '换成按季度汇总' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('redirect_next'));
    expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'sendMemberInput', expect.objectContaining({ mode: 'redirect' }));
    expect(screen.getByTestId('member-input-receipt').textContent).toContain(zh.expert.memberBar.receiptRedirectNextStep);
  });

  it('没送到（成员已收工）：草稿留着，回执带原因，主对话不落记录', async () => {
    runningMember();
    invokeDomainMock.mockResolvedValue({ outcome: 'rejected', reason: 'finished' });

    render(<MemberConversationView sessionId="session-1" />);
    const input = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '再补一句' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('rejected'));
    expect(screen.getByTestId('member-input-receipt').textContent).toContain(zh.expert.memberBar.rejectFinished);
    expect(input.value).toBe('再补一句');
    expect(useSessionStore.getState().messages).toHaveLength(0);
  });

  it('送到了但主会话没记下：清草稿并提示别重发（重发会让成员执行两次）', async () => {
    runningMember();
    invokeDomainMock.mockResolvedValue({ outcome: 'delivered', effect: 'next_step', persisted: false });

    render(<MemberConversationView sessionId="session-1" />);
    const input = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '只执行一次' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(zh.expert.memberBar.sentNotRecorded));
    expect(input.value).toBe('');
    expect(useSessionStore.getState().messages).toHaveLength(0);
  });

  it('切换成员时清草稿，旧发送的结果作废不显示', async () => {
    runningMember();
    swarmState.agents = [agentOf({ status: 'running' }), agentOf({ id: 'writer', name: '撰稿员', role: 'writer', status: 'running' })];
    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([{ ...ledgerRun, status: 'running', endedAt: null }]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve({ ...ledgerDetail, agents: [
          { ...record, status: 'running', endTime: null },
          { ...writerRecord, status: 'running', endTime: null },
        ] });
      }
      return Promise.resolve(null);
    });
    let resolveOld: ((value: unknown) => void) | undefined;
    invokeDomainMock.mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));

    render(<MemberConversationView sessionId="session-1" />);
    const oldInput = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    fireEvent.change(oldInput, { target: { value: 'A draft' } });
    fireEvent.keyDown(oldInput, { key: 'Enter' });

    useMemberViewStore.setState({ viewingMemberId: 'writer' });
    const newInput = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    await waitFor(() => expect(newInput.value).toBe(''));
    fireEvent.change(newInput, { target: { value: 'B draft' } });

    resolveOld?.({ outcome: 'rejected', reason: 'finished' });
    // 真刷一次（一个微任务不够让 invoke 的 await 落地——变异实测：只 await Promise.resolve() 的断言是瞎的）
    await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 20); }));
    expect(newInput.value).toBe('B draft');
    expect(screen.queryByTestId('member-input-receipt')).toBeNull();

    // 正向对照：同样的刷新时长下，当前成员自己的发送结果是能显示出来的
    invokeDomainMock.mockResolvedValue({ outcome: 'delivered', effect: 'next_step', persisted: false });
    fireEvent.keyDown(newInput, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('delivered'));
  });

  it('已收工的成员：没有输入框，只留「回主会话再派」，也没有停止按钮', async () => {
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-input-finished')).toBeTruthy());
    expect(screen.getByTestId('member-input-finished').textContent)
      .toBe(zh.expert.memberBar.finishedHint.replace('{name}', '行业研究员'));
    expect(screen.queryByTestId('member-input')).toBeNull();
    expect(screen.queryByTestId('member-view-stop')).toBeNull();
    expect(invokeDomainMock).not.toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'sendMemberInput', expect.anything());
  });

  it('顶栏「停掉这位成员」：专家团成员走 swarm:cancel-agent', async () => {
    runningMember();

    render(<MemberConversationView sessionId="session-1" />);
    const stop = await screen.findByTestId('member-view-stop');
    expect(stop.textContent).toContain(zh.expert.memberBar.stopMember);
    fireEvent.click(stop);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.SWARM_CANCEL_AGENT,
      { sessionId: 'session-1', runId: 'run-1', agentId: 'researcher' },
    ));
  });

  it('后台任务：kind=task 不需要 runId，steer 成功回执「已读到」；停掉走 cancelBackgroundTask', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    const task: Task = {
      id: 'task-7', sessionId: 'session-1', source: 'delegate_task', title: '核对发布清单',
      status: 'running', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    };
    useBackgroundTaskStore.setState({ tasks: [task] });
    useSessionStore.setState({ currentSessionId: 'session-1', messages: [] });
    useMemberViewStore.setState({ viewingMemberId: 'task-7' });
    const domainInvoke = vi.fn().mockResolvedValue(null);
    (window as unknown as { domainAPI?: unknown }).domainAPI = { invoke: domainInvoke };
    invokeDomainMock.mockImplementation((domain: unknown, action: unknown) => {
      if (domain === IPC_DOMAINS.AGENT && action === 'sendMemberInput') {
        return Promise.resolve({ outcome: 'delivered', effect: 'now', persisted: true });
      }
      return Promise.resolve(null);
    });

    render(<MemberConversationView sessionId="session-1" />);
    const input = await screen.findByTestId('member-input');
    fireEvent.change(input, { target: { value: '优先给业务结论' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('read'));
    expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.AGENT, 'sendMemberInput', expect.objectContaining({
      memberId: 'task-7', kind: 'task', runId: undefined, mode: 'supplement',
    }));
    expect(screen.getByTestId('member-input-receipt').textContent).toContain(zh.expert.memberBar.receiptRead);
    // 后台任务路径的主对话记录由运行时以 isMeta 落库，渲染层不另插一条
    expect(useSessionStore.getState().messages).toHaveLength(0);

    fireEvent.click(screen.getByTestId('member-view-stop'));
    await waitFor(() => expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.TASK, 'cancelBackgroundTask', { taskId: 'task-7' }));
    (window as unknown as { domainAPI?: unknown }).domainAPI = undefined;
  });

  it('后台任务排队中送到但记录没写成：清草稿并提示别重发（任务书已经改了，重发会重复追加）', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    const task: Task = {
      id: 'task-8', sessionId: 'session-1', source: 'delegate_task', title: '核对发布清单',
      status: 'queued', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    };
    useBackgroundTaskStore.setState({ tasks: [task] });
    useSessionStore.setState({ currentSessionId: 'session-1', messages: [] });
    useMemberViewStore.setState({ viewingMemberId: 'task-8' });
    invokeDomainMock.mockImplementation((domain: unknown, action: unknown) => (
      domain === IPC_DOMAINS.AGENT && action === 'sendMemberInput'
        ? Promise.resolve({ outcome: 'delivered', effect: 'queued', persisted: false })
        : Promise.resolve(null)
    ));

    render(<MemberConversationView sessionId="session-1" />);
    const input = await screen.findByTestId('member-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '只执行一次' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(zh.expert.memberBar.sentNotRecorded));
    expect(input.value).toBe('');
    expect(screen.getByTestId('member-input-receipt').getAttribute('data-state')).toBe('queued');
  });
});
