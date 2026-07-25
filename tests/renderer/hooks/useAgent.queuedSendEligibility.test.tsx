// @vitest-environment jsdom
//
// 「引导消息点发送没反应」的根因门。
//
// 根因：判「能不能发」和判「发出去会不会被排队」用的是两套判据——
//   ChatView.tsx  effectiveIsProcessing = running | queued（+本地 processing 集合）
//   useAgentIPC   isRuntimeBusyStatus   = running | queued | paused
// 于是 status='paused' 时按钮显示、点下去却被 sendMessage 重新排队；
// status='cancelling' 时按钮显示、点下去抛 'Session is already cancelling' 被内层
// catch 吞掉后静默 requeue。两条都是「点了没反应」，且前者会把原条目永久留在
// 'sending' 态（listSessionsWithQueuedInputs 明写 sending 孤儿行不恢复 = 消息丢失）。
//
// 本门钉三件事：不发（不产生孤儿行）、条目留在原地、必须出声说明原因。

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { QueuedInputSchemas } from '../../../src/shared/ipc/schemas';
import type { QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';

const typedInvokeDomainMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const toastInfoMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastWarningMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: toastInfoMock, error: toastErrorMock, warning: toastWarningMock, success: vi.fn() },
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
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
    useAgentIPC: (_args: { enqueueRuntimeInput: (input: QueuedRuntimeInput) => void }) => ({
      sendMessage: sendMessageMock,
      cancel: cancelMock,
    }),
  };
});

import { useAgent } from '../../../src/renderer/hooks/useAgent';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import type { TaskSessionStatus } from '../../../src/renderer/stores/taskStore';

function hostQueuedInput(): QueuedInput {
  return {
    id: 'queued-a',
    sessionId: 'session-a',
    envelope: {
      content: '引导内容',
      sessionId: 'session-a',
      context: { runtimeInput: { mode: 'guided', delivery: 'queued_next_turn' } },
    },
    status: 'queued',
    retryCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  };
}

function mockHost(): void {
  typedInvokeDomainMock.mockImplementation(
    async (_schema: unknown, request: { action: string }) => {
      switch (request.action) {
        case 'list':
          return { success: true, data: [hostQueuedInput()] };
        case 'markSending':
          return { success: true, data: { marked: true } };
        case 'reportSendOutcome':
          return { success: true, data: { status: 'consumed', retryCount: 0 } };
        default:
          return { success: true, data: undefined };
      }
    },
  );
}

async function renderHydrated() {
  const hook = renderHook(() => useAgent());
  await waitFor(() => {
    expect(hook.result.current.queuedRuntimeInputs.map((queued) => queued.id))
      .toEqual(['queued-a']);
  });
  return hook;
}

function setSessionStatus(status: TaskSessionStatus, locallyProcessing = false): void {
  useAppStore.setState({
    isProcessing: locallyProcessing,
    processingSessionIds: new Set(locallyProcessing ? ['session-a'] : []),
  });
  useTaskStore.setState({ sessionStates: { 'session-a': { status } } });
}

describe('引导消息「发送」的可发判定与 sendMessage 同源', () => {
  beforeEach(() => {
    typedInvokeDomainMock.mockReset();
    sendMessageMock.mockReset();
    cancelMock.mockReset();
    toastInfoMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
    sendMessageMock.mockResolvedValue(undefined);
    useSessionStore.setState({ currentSessionId: 'session-a', messages: [] });
    setSessionStatus('idle');
    mockHost();
  });

  // status='paused' 是 isRuntimeBusyStatus 里有、ChatView 的 effectiveIsProcessing 里没有的那一档，
  // 也就是「按钮显示但发不出去」的窗口本身。
  it.each<[TaskSessionStatus]>([
    ['paused'],
    ['cancelling'],
  ])('会话处于 %s 时不静默吞掉：不 markSending、条目留在原地、出声说明原因', async (status) => {
    const hook = await renderHydrated();
    setSessionStatus(status);

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    // 不产生孤儿行：markSending 一旦成功而 sendMessage 又把消息重新排队，
    // 原行就永久停在 'sending'（宿主明确不恢复 sending 孤儿行）= 用户的话丢了。
    expect(typedInvokeDomainMock).not.toHaveBeenCalledWith(
      QueuedInputSchemas.MARK_SENDING,
      expect.anything(),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(hook.result.current.queuedRuntimeInputs.map((input) => input.id))
      .toEqual(['queued-a']);
    // 出声：按不动时必须说清为什么，而不是让按钮看起来是坏的。
    expect(toastInfoMock).toHaveBeenCalledTimes(1);
    expect(String(toastInfoMock.mock.calls[0]?.[0] ?? '')).not.toHaveLength(0);
  });

  it('会话空闲时照常发送（不误伤正常路径）', async () => {
    const hook = await renderHydrated();

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      QueuedInputSchemas.MARK_SENDING,
      { action: 'markSending', payload: { id: 'queued-a' } },
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      hostQueuedInput().envelope,
      { silentFailure: true },
    );
    expect(toastInfoMock).not.toHaveBeenCalled();
  });

  // 可达的重复点击窗口在 markSending 落地之前——落地之后条目已被乐观移除，气泡消失也就点不到了。
  it('同一条正在发送中再点一次，也要出声而不是静默 return', async () => {
    const hook = await renderHydrated();
    let releaseMarkSending!: () => void;
    typedInvokeDomainMock.mockImplementation(
      async (_schema: unknown, request: { action: string }) => {
        switch (request.action) {
          case 'list':
            return { success: true, data: [hostQueuedInput()] };
          case 'markSending':
            await new Promise<void>((resolve) => { releaseMarkSending = resolve; });
            return { success: true, data: { marked: true } };
          default:
            return { success: true, data: { status: 'consumed', retryCount: 0 } };
        }
      },
    );

    let firstClick!: Promise<void>;
    await act(async () => {
      firstClick = hook.result.current.sendQueuedRuntimeInput('queued-a');
      await Promise.resolve();
    });

    await act(async () => {
      await hook.result.current.sendQueuedRuntimeInput('queued-a');
    });

    const markSendingCalls = typedInvokeDomainMock.mock.calls
      .filter(([, request]) => (request as { action: string }).action === 'markSending');
    expect(markSendingCalls).toHaveLength(1);
    expect(toastInfoMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseMarkSending();
      await firstClick;
    });
  });
});
