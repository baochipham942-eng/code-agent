// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { QueuedInputSchemas } from '../../../src/shared/ipc/schemas';
import type { QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';

const typedInvokeDomainMock = vi.hoisted(() => vi.fn());
const enqueueRuntimeInputFromHook = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: toastMocks,
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
  | { action: 'retract'; payload: { id: string } };

function hostQueuedInput(id: string): QueuedInput {
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

function mockQueuedHost(input: QueuedInput | null, retracted: boolean): void {
  typedInvokeDomainMock.mockImplementation(
    async (_schema: unknown, request: QueuedInputAction) => {
      if (request.action === 'list') {
        return { success: true, data: input ? [input] : [] };
      }
      return { success: true, data: { retracted } };
    },
  );
}

describe('useAgent queued input retraction', () => {
  beforeEach(() => {
    typedInvokeDomainMock.mockReset();
    enqueueRuntimeInputFromHook.mockReset();
    sendMessageMock.mockReset();
    cancelMock.mockReset();
    toastMocks.info.mockReset();
    toastMocks.error.mockReset();
    useSessionStore.setState({ currentSessionId: 'session-a', messages: [] });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-a']),
    });
    useTaskStore.setState({
      sessionStates: { 'session-a': { status: 'running' } },
    });
  });

  it('removes a queued item locally after the host retracts it', async () => {
    const queued = hostQueuedInput('queued-a');
    mockQueuedHost(queued, true);
    const hook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
        .toEqual(['queued-a']);
    });

    await act(async () => {
      await hook.result.current.cancelQueuedRuntimeInput('queued-a');
    });

    expect(typedInvokeDomainMock).toHaveBeenLastCalledWith(
      QueuedInputSchemas.RETRACT,
      { action: 'retract', payload: { id: 'queued-a' } },
    );
    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);
    expect(toastMocks.info).not.toHaveBeenCalled();
  });

  it('keeps the local item and informs the user when the host rejects retraction', async () => {
    const queued = hostQueuedInput('sending-a');
    mockQueuedHost(queued, false);
    const hook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
        .toEqual(['sending-a']);
    });

    await act(async () => {
      await hook.result.current.cancelQueuedRuntimeInput('sending-a');
    });

    expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
      .toEqual(['sending-a']);
    expect(toastMocks.info).toHaveBeenCalledWith('这条消息已经开始发送，无法撤回。');
  });

  it('removes a terminal sendFailed item without calling the host', async () => {
    mockQueuedHost(null, true);
    const hook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(typedInvokeDomainMock).toHaveBeenCalledTimes(1);
    });
    const failed: QueuedRuntimeInput = {
      id: 'failed-a',
      sessionId: 'session-a',
      envelope: { content: 'failed', sessionId: 'session-a' },
      content: 'failed',
      mode: 'supplement',
      attachmentsCount: 0,
      createdAt: 1_700_000_000_000,
      retryCount: 4,
      sendFailed: true,
    };
    act(() => {
      enqueueRuntimeInputFromHook(failed);
    });
    expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
      .toEqual(['failed-a']);

    await act(async () => {
      await hook.result.current.cancelQueuedRuntimeInput('failed-a');
    });

    expect(hook.result.current.queuedRuntimeInputs).toEqual([]);
    expect(typedInvokeDomainMock).toHaveBeenCalledTimes(1);
  });
});
