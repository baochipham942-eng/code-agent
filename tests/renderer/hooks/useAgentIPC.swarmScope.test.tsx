// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function swarmEvent(type: SwarmEvent['type'], data: SwarmEvent['data']): SwarmEvent {
  return {
    type,
    sessionId: 'session-direct',
    runId: 'run-direct',
    treeId: 'tree-direct',
    timestamp: 1,
    data,
  };
}

function renderDirectHook() {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: 'session-direct',
    currentTurnMessageIdRef: { current: null },
    enqueueRuntimeInput: vi.fn(),
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: vi.fn(),
  }));
}

const envelope = {
  content: '只发给 reviewer',
  sessionId: 'session-direct',
  context: {
    routing: {
      mode: 'direct' as const,
      targetAgentIds: ['agent-reviewer'],
    },
  },
};

describe('useAgentIPC direct swarm scope', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useSessionStore.setState({ currentSessionId: 'session-direct', messages: [] });
    useSwarmStore.getState().reset();
    useSwarmStore.getState().activateScope('session-direct', 'run-direct');
    useSwarmStore.getState().handleEvent(swarmEvent('swarm:started', {}));
    useSwarmStore.getState().handleEvent(swarmEvent('swarm:agent:added', {
      agentId: 'agent-reviewer',
      agentState: {
        id: 'agent-reviewer',
        name: 'reviewer',
        role: 'reviewer',
        status: 'running',
        iterations: 0,
      },
    }));
    useAppStore.setState({ selectedSwarmAgentId: null });
  });

  it('includes the selected session and run in direct delivery', async () => {
    invokeMock.mockResolvedValue({ delivered: true, persisted: true });
    const hook = renderDirectHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.SWARM_SEND_USER_MESSAGE,
      expect.objectContaining({
        sessionId: 'session-direct',
        runId: 'run-direct',
        agentId: 'agent-reviewer',
        message: '只发给 reviewer',
        metadata: expect.objectContaining({
          workbench: expect.not.objectContaining({ directRoutingDelivery: expect.anything() }),
        }),
      }),
    );
  });

  it('rolls back the visible user message when Host reports delivered:false', async () => {
    invokeMock.mockResolvedValue({ delivered: false, persisted: false });
    const hook = renderDirectHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(useSessionStore.getState().messages.some((message) => message.role === 'user')).toBe(false);
    expect(useSessionStore.getState().messages.at(-1)?.content).toContain('Direct 路由发送失败');
  });

  it('keeps a delivered message visible when persistence fails and reports the exact state', async () => {
    invokeMock.mockResolvedValue({ delivered: true, persisted: false });
    const hook = renderDirectHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(useSessionStore.getState().messages.some((message) => message.role === 'user')).toBe(true);
    expect(useSessionStore.getState().messages.at(-1)?.content).toContain('已送达但未写入 Team 记录');
  });

  it('uses allSettled so one transport failure does not roll back a successful target', async () => {
    useSwarmStore.getState().handleEvent(swarmEvent('swarm:agent:added', {
      agentId: 'agent-writer',
      agentState: {
        id: 'agent-writer',
        name: 'writer',
        role: 'writer',
        status: 'running',
        iterations: 0,
      },
    }));
    invokeMock
      .mockResolvedValueOnce({ delivered: true, persisted: true })
      .mockRejectedValueOnce(new Error('transport down'));
    const hook = renderDirectHook();

    await act(async () => {
      await hook.result.current.sendMessage({
        ...envelope,
        context: {
          routing: {
            mode: 'direct',
            targetAgentIds: ['agent-reviewer', 'agent-writer'],
          },
        },
      });
    });

    expect(useSessionStore.getState().messages.some((message) => message.role === 'user')).toBe(true);
    expect(useSessionStore.getState().messages.at(-1)?.content).toContain('未送达 agent-writer');
    expect(useAppStore.getState().selectedSwarmAgentId).toBe('agent-reviewer');
  });

  it('drops late Direct results after the user switches session/run', async () => {
    let resolveDelivery!: (value: { delivered: boolean; persisted: boolean }) => void;
    invokeMock.mockReturnValue(new Promise((resolve) => { resolveDelivery = resolve; }));
    const hook = renderDirectHook();
    let pending!: Promise<void>;

    await act(async () => {
      pending = hook.result.current.sendMessage(envelope);
      await Promise.resolve();
    });
    const sessionBMessage = {
      id: 'session-b-message',
      role: 'assistant' as const,
      content: 'keep-b',
      timestamp: 1,
    };
    useSessionStore.setState({
      currentSessionId: 'session-b',
      messages: [sessionBMessage],
    });
    useAppStore.setState({ selectedSwarmAgentId: 'agent-b' });

    resolveDelivery({ delivered: false, persisted: false });
    await act(async () => {
      await pending;
    });

    expect(useSessionStore.getState().messages).toEqual([sessionBMessage]);
    expect(useAppStore.getState().selectedSwarmAgentId).toBe('agent-b');
  });
});
