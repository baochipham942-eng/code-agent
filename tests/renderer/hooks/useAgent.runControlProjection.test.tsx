// @vitest-environment jsdom
//
// T1：useAgent → runControlStore 的投影契约。
// 右栏 Overview 只能拿到这个 store 里的东西，所以「投歪了」在 UI 上表现为
// 「点了没反应」或「点删除结果发出去了」——这里把三个动作的身份逐个钉死，
// 并真跑一条 retract 证明经 store 调下去落到的是 host QueuedInput IPC。

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { QueuedInputSchemas } from '../../../src/shared/ipc/schemas';

const typedInvokeDomainMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/hooks/agent/useAgentEffects', () => ({
  useAgentEffects: vi.fn(),
}));

// unstableCancel=true 时每次渲染返回一个新的 cancel，用来模拟上游回调身份变化。
const unstableCancel = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../../src/renderer/hooks/agent/useAgentIPC', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/renderer/hooks/agent/useAgentIPC')
  >();
  return {
    ...actual,
    useAgentIPC: () => ({
      sendMessage: sendMessageMock,
      cancel: unstableCancel.enabled ? (...args: unknown[]) => cancelMock(...args) : cancelMock,
    }),
  };
});

import { useAgent } from '../../../src/renderer/hooks/useAgent';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useRunControlStore } from '../../../src/renderer/stores/runControlStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

function hostQueuedInput(id: string, content: string): QueuedInput {
  return {
    id,
    sessionId: 'session-a',
    envelope: { content, sessionId: 'session-a', attachments: undefined },
    status: 'queued',
    retryCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  };
}

describe('useAgent → runControlStore projection', () => {
  beforeEach(() => {
    typedInvokeDomainMock.mockReset();
    sendMessageMock.mockReset();
    cancelMock.mockReset();
    unstableCancel.enabled = false;
    useRunControlStore.setState({ queue: [], actions: null });
    useSessionStore.setState({ currentSessionId: 'session-a', messages: [] });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-a']),
    });
    useTaskStore.setState({ sessionStates: { 'session-a': { status: 'running' } } });
    typedInvokeDomainMock.mockImplementation(
      async (_schema: unknown, request: { action: string }) => {
        if (request.action === 'list') {
          return { success: true, data: [hostQueuedInput('queued-a', '先把结论写出来')] };
        }
        return { success: true, data: { retracted: true } };
      },
    );
  });

  it('projects the visible queue into the store', async () => {
    renderHook(() => useAgent());

    await waitFor(() => {
      expect(useRunControlStore.getState().queue).toEqual([
        { id: 'queued-a', content: '先把结论写出来', attachmentsCount: 0, sendFailed: undefined },
      ]);
    });
  });

  it('publishes each action as the matching useAgent callback, not a look-alike', async () => {
    const hook = renderHook(() => useAgent());

    await waitFor(() => {
      expect(useRunControlStore.getState().actions).not.toBeNull();
    });

    const actions = useRunControlStore.getState().actions!;
    // retract 与 sendNow 签名相同 ((id: string) => Promise<void>)，typecheck 拦不住
    // 互换——只能按身份逐个对。
    expect(actions.retractQueued).toBe(hook.result.current.cancelQueuedRuntimeInput);
    expect(actions.sendQueuedNow).toBe(hook.result.current.sendQueuedRuntimeInput);
    expect(actions.interrupt).toBe(hook.result.current.cancel);
  });

  it('reaches the host retract IPC when the projected action is invoked', async () => {
    renderHook(() => useAgent());
    await waitFor(() => {
      expect(useRunControlStore.getState().queue).toHaveLength(1);
    });

    await act(async () => {
      await useRunControlStore.getState().actions!.retractQueued('queued-a');
    });

    expect(typedInvokeDomainMock).toHaveBeenLastCalledWith(
      QueuedInputSchemas.RETRACT,
      { action: 'retract', payload: { id: 'queued-a' } },
    );
    expect(useRunControlStore.getState().queue).toEqual([]);
  });

  it('keeps the queue visible when the published callbacks change identity', async () => {
    unstableCancel.enabled = true;
    const hook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(useRunControlStore.getState().queue).toHaveLength(1);
    });
    const firstInterrupt = useRunControlStore.getState().actions!.interrupt;

    hook.rerender();

    // 动作确实换了身份（说明这一轮 effect 真的重跑了），但排队消息不能跟着蒸发。
    expect(useRunControlStore.getState().actions!.interrupt).not.toBe(firstInterrupt);
    expect(useRunControlStore.getState().queue).toHaveLength(1);
  });

  it('drops actions and queue when the chat runtime unmounts', async () => {
    const hook = renderHook(() => useAgent());
    await waitFor(() => {
      expect(useRunControlStore.getState().actions).not.toBeNull();
    });

    hook.unmount();

    // 聊天运行时没挂载时留着动作 = 给 Overview 一批点了没反应的按钮。
    expect(useRunControlStore.getState().actions).toBeNull();
    expect(useRunControlStore.getState().queue).toEqual([]);
  });
});
