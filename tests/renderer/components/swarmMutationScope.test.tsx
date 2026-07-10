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

    fireEvent.click(view.getByRole('button', { name: '开始执行' }));

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

    fireEvent.click(view.getByRole('button', { name: '开始执行' }));
    useSessionStore.setState({ currentSessionId: 'session-next' });
    useSwarmStore.getState().activateScope('session-next', 'run-next');
    resolveApproval?.(true);

    await waitFor(() => {
      expect(useSwarmStore.getState().activeSessionId).toBe('session-next');
      expect(useSwarmStore.getState().activeRunId).toBe('run-next');
    });
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
