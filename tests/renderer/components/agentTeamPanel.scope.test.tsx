// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

import { AgentTeamPanel } from '../../../src/renderer/components/features/agentTeam/AgentTeamPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

const AGENT_ID = 'reviewer';

function event(
  type: SwarmEvent['type'],
  sessionId: string,
  runId: string,
  data: SwarmEvent['data'],
  timestamp: number,
): SwarmEvent {
  return {
    type,
    sessionId,
    runId,
    treeId: `tree-${runId}`,
    timestamp,
    data,
  };
}

function seedRun(sessionId: string, runId: string, timestamp: number): void {
  const store = useSwarmStore.getState();
  store.handleEvent(event('swarm:started', sessionId, runId, {}, timestamp));
  store.handleEvent(event('swarm:agent:added', sessionId, runId, {
    agentId: AGENT_ID,
    agentState: {
      id: AGENT_ID,
      name: `Reviewer ${sessionId}`,
      role: 'reviewer',
      status: 'running',
      iterations: 0,
    },
  }, timestamp + 1));
}

describe('AgentTeamPanel run scope', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useSwarmStore.getState().reset();
    useSwarmStore.getState().activateScope('session-a', 'run-a');
    seedRun('session-a', 'run-a', 100);
    useAppStore.setState({ selectedSwarmAgentId: AGENT_ID });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps input and renders an error when Host returns delivered:false', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES) return Promise.resolve([]);
      if (channel === IPC_CHANNELS.SWARM_SEND_USER_MESSAGE) {
        return Promise.resolve({ delivered: false, persisted: false });
      }
      return Promise.resolve(undefined);
    });

    const view = render(
      <AgentTeamPanel sessionId="session-a" runId="run-a" />,
    );
    const input = view.getByPlaceholderText('发消息给 Reviewer session-a…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '请复核实现' } });
    fireEvent.click(view.getByRole('button', { name: '发送消息' }));

    await waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('消息未送达');
    });
    expect(input.value).toBe('请复核实现');
    expect(useSwarmStore.getState().messages).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.SWARM_SEND_USER_MESSAGE,
      expect.objectContaining({
        sessionId: 'session-a',
        runId: 'run-a',
        agentId: AGENT_ID,
        message: '请复核实现',
        messageId: expect.any(String),
        timestamp: expect.any(Number),
      }),
    );
  });

  it('clears input without asking for retry when delivery succeeded but persistence failed', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES) return Promise.resolve([]);
      if (channel === IPC_CHANNELS.SWARM_SEND_USER_MESSAGE) {
        return Promise.resolve({ delivered: true, persisted: false });
      }
      return Promise.resolve(undefined);
    });

    const view = render(<AgentTeamPanel sessionId="session-a" runId="run-a" />);
    const input = view.getByPlaceholderText('发消息给 Reviewer session-a…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '只执行一次' } });
    fireEvent.click(view.getByRole('button', { name: '发送消息' }));

    await waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('请勿重复发送');
    });
    expect(input.value).toBe('');
  });

  it('drops stale history and foreign live messages after switching run scope', async () => {
    let resolveSessionA: ((messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      timestamp: number;
      messageType?: string;
    }>) => void) | undefined;
    invokeMock.mockImplementation((channel: string, payload: { sessionId?: string }) => {
      if (channel !== IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES) return Promise.resolve(undefined);
      if (payload.sessionId === 'session-a') {
        return new Promise((resolve) => {
          resolveSessionA = resolve;
        });
      }
      return Promise.resolve([{
        id: 'ledger-b',
        from: AGENT_ID,
        to: 'user',
        content: 'B ledger',
        timestamp: 220,
        messageType: 'response',
      }]);
    });

    const view = render(
      <AgentTeamPanel sessionId="session-a" runId="run-a" />,
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES, {
        sessionId: 'session-a',
        runId: 'run-a',
        agentId: AGENT_ID,
      });
    });

    seedRun('session-b', 'run-b', 200);
    useSwarmStore.getState().activateScope('session-b', 'run-b');
    useAppStore.setState({ selectedSwarmAgentId: AGENT_ID });
    view.rerender(<AgentTeamPanel sessionId="session-b" runId="run-b" />);

    await waitFor(() => {
      expect(view.getByText('B ledger')).toBeTruthy();
    });

    resolveSessionA?.([{
      id: 'ledger-a',
      from: AGENT_ID,
      to: 'user',
      content: 'A stale ledger',
      timestamp: 120,
      messageType: 'response',
    }]);
    useSwarmStore.getState().handleEvent(event('swarm:agent:message', 'session-a', 'run-a', {
      agentId: AGENT_ID,
      message: {
        id: 'live-a',
        from: AGENT_ID,
        to: 'user',
        content: 'A late live',
        messageType: 'response',
      },
    }, 230));
    await Promise.resolve();

    expect(view.queryByText('A stale ledger')).toBeNull();
    expect(view.queryByText('A late live')).toBeNull();
    expect(view.getByText('B ledger')).toBeTruthy();
  });

  it('renders one stable message when the same scoped event is replayed', async () => {
    invokeMock.mockResolvedValue([]);
    const replayed = event('swarm:user:message', 'session-a', 'run-a', {
      agentId: AGENT_ID,
      message: {
        id: 'user-message-1',
        from: 'user',
        to: AGENT_ID,
        content: '只显示一次',
        messageType: 'user',
      },
    }, 300);

    useSwarmStore.getState().handleEvent(replayed);
    useSwarmStore.getState().handleEvent(replayed);
    const view = render(<AgentTeamPanel sessionId="session-a" runId="run-a" />);

    await waitFor(() => {
      expect(view.getAllByText('只显示一次')).toHaveLength(1);
    });
  });

  it('clears the draft on scope switch and ignores the old send promise result', async () => {
    let resolveOldSend: ((result: { delivered: boolean; persisted: boolean }) => void) | undefined;
    invokeMock.mockImplementation((channel: string, payload: { sessionId?: string }) => {
      if (channel === IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES) return Promise.resolve([]);
      if (channel === IPC_CHANNELS.SWARM_SEND_USER_MESSAGE && payload.sessionId === 'session-a') {
        return new Promise((resolve) => {
          resolveOldSend = resolve;
        });
      }
      return Promise.resolve({ delivered: true, persisted: true });
    });

    const view = render(<AgentTeamPanel sessionId="session-a" runId="run-a" />);
    const oldInput = view.getByPlaceholderText('发消息给 Reviewer session-a…') as HTMLInputElement;
    fireEvent.change(oldInput, { target: { value: 'A draft' } });
    fireEvent.click(view.getByRole('button', { name: '发送消息' }));

    seedRun('session-b', 'run-b', 400);
    useSwarmStore.getState().activateScope('session-b', 'run-b');
    useAppStore.setState({ selectedSwarmAgentId: AGENT_ID });
    view.rerender(<AgentTeamPanel sessionId="session-b" runId="run-b" />);

    const newInput = await view.findByPlaceholderText('发消息给 Reviewer session-b…') as HTMLInputElement;
    await waitFor(() => expect(newInput.value).toBe(''));
    fireEvent.change(newInput, { target: { value: 'B draft' } });

    resolveOldSend?.({ delivered: false, persisted: false });
    await Promise.resolve();

    expect(newInput.value).toBe('B draft');
    expect(view.queryByRole('alert')).toBeNull();
  });
});
