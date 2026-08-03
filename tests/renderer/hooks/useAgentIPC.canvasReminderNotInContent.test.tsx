// @vitest-environment jsdom
// ============================================================================
// 注入卫生工单（2026-08-01）修 1：画布会话冷启动引导此前由 renderer 侧
// applyDesignCanvasSessionToContent prepend 进发出的 content——而这份 content 会被
// 原样持久化 + 渲染为用户气泡，导致 <system-reminder kind="design-canvas-session">
// 全文泄漏进用户可见消息（真机走查实证）。改为服务端按轮注入 systemPrompt/
// turnSystemContext 后，renderer 发给 host 的 content 必须是用户原文，不带任何
// <system-reminder> 块；引导改走 context.executionIntent.designCanvasActive。
// ============================================================================
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

const invokeMock = vi.hoisted(() => vi.fn());
const typedInvokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

import { useAgentIPC, type QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';

const SESSION_ID = 'session-canvas-hygiene';

function renderSendHook() {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    enqueueRuntimeInput: vi.fn<(input: QueuedRuntimeInput) => void>(),
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC sendMessage：设计画布会话下不再把 reminder 拼进 content', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    typedInvokeDomainMock.mockReset();
    useSessionStore.setState({ currentSessionId: SESSION_ID, messages: [] });
    useSwarmStore.getState().reset();
    useAppStore.setState({ isProcessing: false, processingSessionIds: new Set<string>() });
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
    // 设计画布会话激活 + 画布属主 == 当前会话（isDesignCanvasActiveForSession 双闸）。
    useDesignCanvasStore.setState({
      designActiveSessions: new Set([SESSION_ID]),
      ownerSessionId: SESSION_ID,
      nodes: [],
      connectors: [],
      shapes: [],
    });
  });

  afterEach(() => {
    useDesignCanvasStore.setState({
      designActiveSessions: new Set<string>(),
      ownerSessionId: null,
      nodes: [],
      connectors: [],
      shapes: [],
    });
  });

  it('host payload 的 content 是用户原文，不含 <system-reminder>；改走 executionIntent.designCanvasActive', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const hook = renderSendHook();
    const envelope: ConversationEnvelope = { content: '生成一张登录页', sessionId: SESSION_ID };

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'agent:send-message',
      expect.objectContaining({
        content: '生成一张登录页',
        context: expect.objectContaining({
          executionIntent: expect.objectContaining({ designCanvasActive: true }),
        }),
      }),
    );
    const sentContent = invokeMock.mock.calls[0]?.[1]?.content;
    expect(sentContent).not.toContain('<system-reminder');
  });

  it('乐观上屏的用户气泡同样不含 <system-reminder>', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const hook = renderSendHook();
    const envelope: ConversationEnvelope = { content: '生成一张登录页', sessionId: SESSION_ID };

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const userMessages = useSessionStore.getState().messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe('生成一张登录页');
  });
});
