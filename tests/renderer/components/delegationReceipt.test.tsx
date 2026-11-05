// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import type { PermissionRequest } from '../../../src/shared/contract/permission';

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  snapshot: null as AgentTreeSnapshot | null,
  openPreview: vi.fn(),
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, PermissionRequest[] | undefined>,
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mocks.tasks }),
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: mocks.snapshot, refresh: vi.fn() }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: {
    processingSessionIds: Set<string>;
    openPreview: typeof mocks.openPreview;
    language: 'zh';
    setLanguage: ReturnType<typeof vi.fn>;
    cloudUIStrings: undefined;
    pendingPermissionRequest: PermissionRequest | null;
    pendingPermissionSessionId: string | null;
    queuedPermissionRequests: Record<string, PermissionRequest[] | undefined>;
  }) => unknown) => {
    // 每次调用重建 state：审批三件套要从 mocks 里读当下值，不能在模块工厂里固化
    const state = {
      processingSessionIds: new Set<string>(),
      openPreview: mocks.openPreview,
      language: 'zh' as const,
      setLanguage: vi.fn(),
      cloudUIStrings: undefined as undefined,
      pendingPermissionRequest: mocks.pendingPermissionRequest,
      pendingPermissionSessionId: mocks.pendingPermissionSessionId,
      queuedPermissionRequests: mocks.queuedPermissionRequests,
    };
    return selector ? selector(state) : state;
  },
}));

function delegateCall(): ToolCall {
  return {
    id: 'delegate-call-1',
    name: 'delegate_task',
    arguments: { description: '核对发布清单' },
    result: { toolCallId: 'delegate-call-1', success: true, output: 'accepted' },
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    source: 'session_command_center',
    sessionId: 'session-1',
    toolCallId: 'delegate-call-1',
    title: '核对发布清单',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    events: [],
    outputRefs: [],
    ...overrides,
  };
}

function renderCall(toolCall = delegateCall()) {
  return render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
}

beforeEach(() => {
  mocks.tasks = [];
  mocks.snapshot = null;
  mocks.openPreview.mockReset();
  mocks.pendingPermissionRequest = null;
  mocks.pendingPermissionSessionId = null;
  mocks.queuedPermissionRequests = {};
});

afterEach(cleanup);

describe('delegation receipt', () => {
  it('shows the background task activity from lastToolStep while running', () => {
    mocks.tasks = [task({
      progress: {
        current: 1,
        total: 2,
        lastToolStep: { tool: 'Read', target: '/repo/release.md', toolIndex: 0, toolTotal: 2, at: 3 },
      },
    })];
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toContain('读取了 /repo/release.md');
    expect(view.getByText('代理工作中')).toBeTruthy();
  });

  it('keeps a completed receipt with title, step count and clickable output refs', () => {
    mocks.tasks = [task({
      status: 'completed',
      progress: {
        current: 2,
        total: 2,
        lastToolStep: { tool: 'Write', target: '/repo/report.md', toolIndex: 1, toolTotal: 2, at: 3 },
      },
      outputRefs: [{
        id: 'output-1',
        taskId: 'task-1',
        type: 'file',
        label: '最终报告',
        path: '/repo/report.md',
        createdAt: 4,
      }],
    })];
    const view = renderCall();

    expect(view.getByText('已完成')).toBeTruthy();
    expect(view.getByText('核对发布清单')).toBeTruthy();
    expect(view.getByText('做了 2 步')).toBeTruthy();
    fireEvent.click(view.getByText('report.md'));
    expect(mocks.openPreview).toHaveBeenCalledWith('/repo/report.md');
  });

  it('shows one failure reason on the terminal receipt', () => {
    mocks.tasks = [task({
      status: 'failed',
      failure: { message: '远端服务超时' },
    })];
    const view = renderCall();

    expect(view.getByText('执行失败')).toBeTruthy();
    expect(view.getByTestId('delegation-failure').textContent).toBe('远端服务超时');
  });

  it('drops the activity and receipt when the matching task disappears instead of keeping stale data', () => {
    mocks.tasks = [task({
      progress: { lastToolStep: { tool: 'Read', target: '/repo/stale.md', at: 3 } },
    })];
    const view = renderCall();
    expect(view.getByTestId('delegation-activity')).toBeTruthy();

    mocks.tasks = [task({
      id: 'unrelated-task',
      toolCallId: 'different-call',
      title: '另一件任务',
      progress: { lastToolStep: { tool: 'Read', target: '/repo/other-stale.md', at: 4 } },
    })];
    view.rerender(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);

    expect(view.queryByTestId('delegation-activity')).toBeNull();
    expect(view.queryByTestId('delegation-receipt')).toBeNull();
    expect(view.queryByText(/stale\.md/)).toBeNull();
    expect(view.getByText('派出后台任务：核对发布清单')).toBeTruthy();
  });

  it('uses the agentTree node for background spawn activity and terminal state', () => {
    const spawnCall: ToolCall = {
      id: 'spawn-call-1',
      name: 'spawn_agent',
      arguments: { task: '审阅改动' },
      result: {
        toolCallId: 'spawn-call-1',
        success: true,
        output: 'Agent [reviewer] spawned in background:\n- Agent ID: agent-1\n- Status: running',
      },
    };
    const runningNode = {
      id: 'agent-1',
      role: '审阅代理',
      status: 'running' as const,
      statusLabel: '正在处理',
      task: '审阅改动',
      children: [],
      lastToolStep: { tool: 'agent_message', target: 'agent-2', at: 4 },
      worktreeState: { status: 'none' as const },
      budgetSummary: {},
      evidenceRefs: [],
      sources: ['spawnGuard' as const],
    };
    const peerNode = {
      ...runningNode,
      id: 'agent-2',
      role: '研究代理',
      task: '研究资料',
      lastToolStep: undefined,
    };
    mocks.snapshot = {
      generatedAt: 5,
      roots: [runningNode, peerNode],
      nodes: [runningNode, peerNode],
      summary: { total: 2, running: 2, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
    };
    const view = renderCall(spawnCall);
    expect(view.getByTestId('delegation-activity').textContent).toBe('正在跟 研究代理 说话');

    const completedNode = { ...runningNode, status: 'completed' as const, statusLabel: '已完成' };
    mocks.snapshot = {
      ...mocks.snapshot,
      roots: [completedNode, peerNode],
      nodes: [completedNode, peerNode],
      summary: { ...mocks.snapshot.summary, running: 1, completed: 1 },
    };
    view.rerender(<ToolCallDisplay toolCall={spawnCall} index={0} total={1} />);
    expect(view.getByTestId('delegation-receipt')).toBeTruthy();
    expect(view.getByText('已完成')).toBeTruthy();
  });
});

// ── N-APPROVAL-PENDING-STATUS-COPY：审批卡还挂着时，工作行不得谎报「发送了邮件」 ──

function pendingMailRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'perm-mail-1',
    type: 'network',
    tool: 'mail_send',
    agentId: 'task-1',
    details: {},
    timestamp: 1,
    ...overrides,
  };
}

function mailTask(overrides: Partial<Task> = {}): Task {
  return task({
    progress: { lastToolStep: { tool: 'mail_send', at: 3 } },
    ...overrides,
  });
}

describe('delegation receipt — approval pending copy', () => {
  it('unresolved pending request: row reads the pending form, never 发送了邮件', () => {
    mocks.tasks = [mailTask()];
    mocks.pendingPermissionRequest = pendingMailRequest();
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toContain('请求发送邮件');
    expect(row).not.toContain('发送了邮件');
  });

  it('queued unresolved request for the session reads the same pending form', () => {
    mocks.tasks = [mailTask()];
    mocks.queuedPermissionRequests = { 'session-1': [pendingMailRequest({ id: 'perm-mail-2' })] };
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toContain('请求发送邮件');
    expect(row).not.toContain('发送了邮件');
  });

  it('request resolved: row falls to the running form (deny answers the card)', () => {
    mocks.tasks = [mailTask()];
    mocks.pendingPermissionRequest = pendingMailRequest({ resolved: true });
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toContain('正在发送邮件');
    expect(row).not.toContain('发送了邮件');
  });

  it('request absent: connector write keeps the running form while working', () => {
    mocks.tasks = [mailTask()];
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toBe('邮件 · 正在发送邮件');
  });

  it('request naming another task does not hijack this row', () => {
    mocks.tasks = [mailTask()];
    mocks.pendingPermissionRequest = pendingMailRequest({ agentId: 'task-other' });
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toBe('邮件 · 正在发送邮件');
  });

  it('read tools keep today wording while working: a pending mail card does not flip them', () => {
    mocks.tasks = [task({
      progress: { lastToolStep: { tool: 'Read', target: '/repo/release.md', at: 3 } },
    })];
    mocks.pendingPermissionRequest = pendingMailRequest();
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toContain('读取了 /repo/release.md');
    expect(view.getByTestId('delegation-activity').textContent).not.toContain('正在读取');
  });

  it('read step awaiting its own approval reads the pending form', () => {
    mocks.tasks = [task({
      progress: { lastToolStep: { tool: 'Read', target: '/repo/release.md', at: 3 } },
    })];
    mocks.pendingPermissionRequest = pendingMailRequest({ tool: 'Read' });
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toContain('请求读取 /repo/release.md');
  });

  it('terminal task: receipt keeps the completed wording for the finished mail step', () => {
    mocks.tasks = [mailTask({ status: 'completed' })];
    const view = renderCall();

    expect(view.getByTestId('delegation-receipt')).toBeTruthy();
    expect(view.queryByTestId('delegation-activity')).toBeNull();
  });
});
