// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { QueuedInputSchemas } from '../../../src/shared/ipc/schemas';
import type { QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';

const typedInvokeDomainMock = vi.hoisted(() => vi.fn());
const enqueueRuntimeInputFromHook = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

vi.mock('../../../src/renderer/hooks/agent/useAgentEffects', () => ({
  useAgentEffects: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/agent/useAgentIPC', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/renderer/hooks/agent/useAgentIPC')
  >();
  return {
    ...actual,
    useAgentIPC: (args: {
      enqueueRuntimeInput: (input: QueuedRuntimeInput) => void;
    }) => {
      enqueueRuntimeInputFromHook.mockImplementation(args.enqueueRuntimeInput);
      return { sendMessage: sendMessageMock, cancel: cancelMock };
    },
  };
});

import { useAgent } from '../../../src/renderer/hooks/useAgent';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

type QueuedInputAction =
  | { action: 'list'; payload: { sessionId: string; status: 'queued' } }
  | { action: 'markSending'; payload: { id: string } }
  | { action: 'reportSendOutcome'; payload: { id: string; outcome: 'success' | 'failure' } };

type FailureOutcome = { status: 'queued' | 'failed'; retryCount: number };

function hostQueuedInput(id = 'queued-a'): QueuedInput {
  return {
    id,
    sessionId: 'session-a',
    envelope: {
      content: `queued-${id}`,
      sessionId: 'session-a',
      context: {
        runtimeInput: { mode: 'supplement', delivery: 'queued_next_turn' },
      },
    },
    status: 'queued',
    retryCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  };
}

function toRuntimeInput(input: QueuedInput): QueuedRuntimeInput {
  return {
    id: input.id,
    sessionId: input.sessionId,
    envelope: input.envelope,
    content: input.envelope.content,
    mode: 'supplement',
    attachmentsCount: 0,
    createdAt: input.createdAt,
    retryCount: input.retryCount,
  };
}

function mockDrainHost(options: {
  input?: QueuedInput;
  marked?: boolean;
  failureOutcome?: FailureOutcome;
} = {}): void {
  const input = options.input ?? hostQueuedInput();
  typedInvokeDomainMock.mockImplementation(
    async (_schema: unknown, request: QueuedInputAction) => {
      switch (request.action) {
        case 'list':
          return { success: true, data: [input] };
        case 'markSending':
          return { success: true, data: { marked: options.marked ?? true } };
        case 'reportSendOutcome':
          return request.payload.outcome === 'success'
            ? { success: true, data: { status: 'consumed', retryCount: input.retryCount } }
            : { success: true, data: options.failureOutcome };
      }
    },
  );
}

async function renderHydrated(input = hostQueuedInput()) {
  const hook = renderHook(() => useAgent());
  await waitFor(() => {
    expect(hook.result.current.queuedRuntimeInputs.map((queued) => queued.id))
      .toEqual([input.id]);
  });
  return hook;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useAgent queued input drain', () => {
  beforeEach(() => {
    typedInvokeDomainMock.mockReset();
    enqueueRuntimeInputFromHook.mockReset();
    sendMessageMock.mockReset();
    cancelMock.mockReset();
    useSessionStore.setState({ currentSessionId: 'session-a', messages: [] });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-a']),
    });
    useTaskStore.setState({
      sessionStates: { 'session-a': { status: 'running' } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send again when the host rejects markSending', async () => {
    mockDrainHost({ marked: false });
    const hook = await renderHydrated();

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      QueuedInputSchemas.MARK_SENDING,
      { action: 'markSending', payload: { id: 'queued-a' } },
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
      .toEqual(['queued-a']);
  });

  it('requeues after 500ms with the retryCount returned by the host', async () => {
    mockDrainHost({ failureOutcome: { status: 'queued', retryCount: 3 } });
    sendMessageMock.mockRejectedValue(new Error('temporary send failure'));
    const hook = await renderHydrated();
    vi.useFakeTimers();

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);
    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      QueuedInputSchemas.REPORT_SEND_OUTCOME,
      { action: 'reportSendOutcome', payload: { id: 'queued-a', outcome: 'failure' } },
    );
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current.queuedRuntimeInputs).toMatchObject([{
      id: 'queued-a',
      retryCount: 3,
    }]);
    expect(hook.result.current.queuedRuntimeInputs[0]?.sendFailed).toBeUndefined();
  });

  it('shows a terminal failed card with the host retryCount and never retries it', async () => {
    mockDrainHost({ failureOutcome: { status: 'failed', retryCount: 5 } });
    sendMessageMock.mockRejectedValue(new Error('permanent send failure'));
    const hook = await renderHydrated();
    vi.useFakeTimers();

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    expect(hook.result.current.queuedRuntimeInputs).toMatchObject([{
      id: 'queued-a',
      retryCount: 5,
      sendFailed: true,
    }]);
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Error: permanent send failure',
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('reports a successful send outcome to the host', async () => {
    mockDrainHost();
    sendMessageMock.mockResolvedValue(undefined);
    const hook = await renderHydrated();

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      hostQueuedInput().envelope,
      { silentFailure: true },
    );
    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      QueuedInputSchemas.REPORT_SEND_OUTCOME,
      { action: 'reportSendOutcome', payload: { id: 'queued-a', outcome: 'success' } },
    );
    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);
  });

  it('does not restore a stale queued snapshot after markSending succeeds', async () => {
    const input = hostQueuedInput('stale-a');
    const listResponse = deferred<{ success: true; data: QueuedInput[] }>();
    const sendResponse = deferred<void>();
    typedInvokeDomainMock.mockImplementation(
      async (_schema: unknown, request: QueuedInputAction) => {
        switch (request.action) {
          case 'list':
            return listResponse.promise;
          case 'markSending':
            return { success: true, data: { marked: true } };
          case 'reportSendOutcome':
            return { success: true, data: { status: 'consumed', retryCount: 0 } };
        }
      },
    );
    sendMessageMock.mockReturnValue(sendResponse.promise);
    const hook = renderHook(() => useAgent());
    act(() => {
      enqueueRuntimeInputFromHook(toRuntimeInput(input));
    });

    let drainPromise!: Promise<void>;
    await act(async () => {
      drainPromise = hook.result.current.sendQueuedRuntimeInput(input.id);
      await Promise.resolve();
    });
    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);

    await act(async () => {
      listResponse.resolve({ success: true, data: [input] });
      await listResponse.promise;
    });
    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);

    await act(async () => {
      sendResponse.resolve(undefined);
      await drainPromise;
    });
  });
});
