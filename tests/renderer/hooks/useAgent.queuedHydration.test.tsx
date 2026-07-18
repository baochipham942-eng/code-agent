// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { QueuedInputSchemas } from '../../../src/shared/ipc/schemas';

const typedInvokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

vi.mock('../../../src/renderer/hooks/agent/useAgentEffects', () => ({
  useAgentEffects: vi.fn(),
}));

import { useAgent } from '../../../src/renderer/hooks/useAgent';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

type ListResponse = { success: true; data: QueuedInput[] };
type ListRequest = {
  action: 'list';
  payload: { sessionId: string; status: 'queued' };
};

function queuedInput(
  id: string,
  sessionId: string,
  options: { mode?: 'supplement' | 'redirect'; retryCount?: number } = {},
): QueuedInput {
  return {
    id,
    sessionId,
    envelope: {
      content: `queued-${id}`,
      sessionId,
      attachments: [{
        id: `attachment-${id}`,
        type: 'file',
        category: 'text',
        name: `${id}.txt`,
        size: 12,
        mimeType: 'text/plain',
      }],
      context: options.mode
        ? { runtimeInput: { mode: options.mode, delivery: 'queued_next_turn' } }
        : undefined,
    },
    status: 'queued',
    retryCount: options.retryCount ?? 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setRunningSession(sessionId: string): void {
  useSessionStore.setState({ currentSessionId: sessionId, messages: [] });
  useAppStore.setState({
    isProcessing: true,
    processingSessionIds: new Set([sessionId]),
  });
}

describe('useAgent queued input hydration', () => {
  beforeEach(() => {
    typedInvokeDomainMock.mockReset();
    setRunningSession('session-a');
    useTaskStore.setState({
      sessionStates: {
        'session-a': { status: 'running' },
        'session-b': { status: 'running' },
      },
    });
  });

  it('restores host-queued runtime inputs when the hook is rebuilt', async () => {
    const persisted = queuedInput('persisted-a', 'session-a', {
      mode: 'redirect',
      retryCount: 2,
    });
    typedInvokeDomainMock.mockResolvedValue({ success: true, data: [persisted] });

    const firstHook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(firstHook.result.current.queuedRuntimeInputs).toEqual([{
        id: 'persisted-a',
        sessionId: 'session-a',
        envelope: persisted.envelope,
        content: 'queued-persisted-a',
        mode: 'redirect',
        attachmentsCount: 1,
        createdAt: persisted.createdAt,
        retryCount: 2,
      }]);
    });
    firstHook.unmount();

    const rebuiltHook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(rebuiltHook.result.current.queuedRuntimeInputs.map((input) => input.id))
        .toEqual(['persisted-a']);
    });

    expect(typedInvokeDomainMock).toHaveBeenCalledTimes(2);
    expect(typedInvokeDomainMock).toHaveBeenLastCalledWith(
      QueuedInputSchemas.LIST,
      {
        action: 'list',
        payload: { sessionId: 'session-a', status: 'queued' },
      },
    );
  });

  it('does not mix a late response from the previous session into the current queue', async () => {
    const sessionAResponse = deferred<ListResponse>();
    const sessionBInput = queuedInput('persisted-b', 'session-b');
    typedInvokeDomainMock.mockImplementation(
      (_schema: unknown, request: ListRequest): Promise<ListResponse> => (
        request.payload.sessionId === 'session-a'
          ? sessionAResponse.promise
          : Promise.resolve({ success: true, data: [sessionBInput] })
      ),
    );

    const hook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(typedInvokeDomainMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useAppStore.setState({ processingSessionIds: new Set(['session-b']) });
      useSessionStore.setState({ currentSessionId: 'session-b' });
    });

    await waitFor(() => {
      expect(hook.result.current.queuedRuntimeInputs).toMatchObject([{
        id: 'persisted-b',
        sessionId: 'session-b',
        mode: 'supplement',
      }]);
    });

    await act(async () => {
      sessionAResponse.resolve({
        success: true,
        data: [queuedInput('late-a', 'session-a')],
      });
      await sessionAResponse.promise;
    });

    expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
      .toEqual(['persisted-b']);
    expect(typedInvokeDomainMock).toHaveBeenLastCalledWith(
      QueuedInputSchemas.LIST,
      {
        action: 'list',
        payload: { sessionId: 'session-b', status: 'queued' },
      },
    );
  });

  it.each(['running', 'paused', 'queued'] as const)(
    'reconciles the local queue when the current session transitions into %s',
    async (status) => {
      const hostDrained = queuedInput(`host-drained-${status}`, 'session-a');
      typedInvokeDomainMock
        .mockResolvedValueOnce({ success: true, data: [hostDrained] })
        .mockResolvedValueOnce({ success: true, data: [] });
      useTaskStore.setState({
        sessionStates: { 'session-a': { status: 'idle' } },
      });

      const hook = renderHook(() => useAgent());
      await waitFor(() => {
        expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
          .toEqual([hostDrained.id]);
      });

      act(() => {
        useTaskStore.setState({
          sessionStates: { 'session-a': { status } },
        });
      });

      await waitFor(() => {
        expect(typedInvokeDomainMock).toHaveBeenCalledTimes(2);
        expect(hook.result.current.queuedRuntimeInputs).toEqual([]);
      });
      expect(typedInvokeDomainMock).toHaveBeenLastCalledWith(
        QueuedInputSchemas.LIST,
        {
          action: 'list',
          payload: { sessionId: 'session-a', status: 'queued' },
        },
      );
    },
  );
});
