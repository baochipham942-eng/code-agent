// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { SwarmLaunchRequest } from '../../../src/shared/contract/swarm';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

import { LaunchRequestCard } from '../../../src/renderer/components/features/swarm/LaunchRequestCard';
import { ApprovalCard } from '../../../src/renderer/components/TaskPanel/orchestration/components';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const scope = { sessionId: 'session-scope', runId: 'run-scope' };

describe('scoped swarm mutations', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
    useSwarmStore.getState().reset();
    useSwarmStore.getState().activateScope('session-scope', 'run-old');
    useSessionStore.setState({ currentSessionId: 'session-scope' });
  });

  afterEach(() => cleanup());

  it('sends launch approval with the request session and run', async () => {
    const request: SwarmLaunchRequest = {
      id: 'request-1',
      ...scope,
      treeId: 'tree-scope',
      status: 'pending',
      requestedAt: 1,
      summary: 'scope launch',
      agentCount: 1,
      dependencyCount: 0,
      writeAgentCount: 0,
      tasks: [{
        id: 'task-1',
        role: 'reviewer',
        task: 'review',
        tools: [],
        writeAccess: false,
      }],
    };
    const view = render(<LaunchRequestCard request={request} />);

    // DecisionCard 骨架：先选「批准启动」选项，再点 primary 确认
    fireEvent.click(view.getByRole('button', { name: /批准启动/ }));
    fireEvent.click(view.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_APPROVE_LAUNCH, {
        ...scope,
        requestId: 'request-1',
        feedback: undefined,
      });
    });
    expect(useSwarmStore.getState().activeSessionId).toBe('session-scope');
    expect(useSwarmStore.getState().activeRunId).toBe('run-scope');
  });

  it('does not reactivate an approved run after the user switched scope', async () => {
    let resolveApproval: ((approved: boolean) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveApproval = resolve;
    }));
    const request: SwarmLaunchRequest = {
      id: 'request-late',
      ...scope,
      treeId: 'tree-scope',
      status: 'pending',
      requestedAt: 1,
      summary: 'scope launch',
      agentCount: 1,
      dependencyCount: 0,
      writeAgentCount: 0,
      tasks: [],
    };
    const view = render(<LaunchRequestCard request={request} />);

    fireEvent.click(view.getByRole('button', { name: /批准启动/ }));
    fireEvent.click(view.getByRole('button', { name: '确认' }));
    useSessionStore.setState({ currentSessionId: 'session-next' });
    useSwarmStore.getState().activateScope('session-next', 'run-next');
    resolveApproval?.(true);

    await waitFor(() => {
      expect(useSwarmStore.getState().activeSessionId).toBe('session-next');
      expect(useSwarmStore.getState().activeRunId).toBe('run-next');
    });
  });

  it('ignores duplicate approve/reject while a launch decision is in flight', async () => {
    let resolveApproval: ((approved: boolean) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveApproval = resolve;
    }));
    const request: SwarmLaunchRequest = {
      id: 'request-double',
      ...scope,
      treeId: 'tree-scope',
      status: 'pending',
      requestedAt: 1,
      summary: 'scope launch',
      agentCount: 1,
      dependencyCount: 0,
      writeAgentCount: 0,
      tasks: [],
    };
    const view = render(<LaunchRequestCard request={request} />);

    // 先填反馈——若 Esc 触达 reject 路径会真实发出 REJECT IPC，断言才够锋利
    fireEvent.change(view.getByPlaceholderText('可选说明；取消编排时填写原因'), {
      target: { value: '在途防护验证' },
    });
    fireEvent.click(view.getByRole('button', { name: /批准启动/ }));
    fireEvent.click(view.getByRole('button', { name: '确认' }));
    // 确认在途：Esc（onCancel → reject 路径）与重复确认都必须被吞（review P1）
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(view.getByRole('button', { name: '确认' }));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_APPROVE_LAUNCH, expect.anything());

    resolveApproval?.(true);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
  });

  it('sends plan rejection with run scope and agent identity', async () => {
    const view = render(
      <ApprovalCard
        scope={scope}
        review={{
          id: 'plan-1',
          agentId: 'agent-reviewer',
          content: 'plan',
          status: 'pending',
          requestedAt: 1,
        }}
      />,
    );
    fireEvent.change(view.getByPlaceholderText('可选反馈；驳回时填写原因'), {
      target: { value: '需要补测试' },
    });
    fireEvent.click(view.getByRole('button', { name: '驳回' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_REJECT_PLAN, {
        ...scope,
        agentId: 'agent-reviewer',
        planId: 'plan-1',
        feedback: '需要补测试',
      });
    });
  });
});
