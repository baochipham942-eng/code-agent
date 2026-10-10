// @vitest-environment jsdom
// ADR-081 协议版本闸的渲染端接线：宿主对「带 environmentSelection 但版本不符」的
// 轮次回 400 + ENVIRONMENT_PROTOCOL_UNSUPPORTED（这一轮没有开始）；发送失败气泡必须
// 给出 i18n 那句话，而不是透传「云端代理请求失败 (400): …」原始报错。

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { ENVIRONMENT_PROTOCOL_UNSUPPORTED } from '../../../src/shared/contract/executionEnvironment';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: invokeDomainMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { environmentProtocolUnsupportedMessage } from '../../../src/renderer/i18n/executionEnvironment';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

// httpTransport 对非 2xx 的 /api/run 抛的错：message 是通用句，稳定码挂在 code 上。
function protocolRejection(): Error & { status: number; code: string } {
  return Object.assign(
    new Error('云端代理请求失败 (400): ENVIRONMENT_PROTOCOL_UNSUPPORTED'),
    { status: 400, code: ENVIRONMENT_PROTOCOL_UNSUPPORTED },
  );
}

const sessionId = 'session-env-protocol-renderer';

const envelope: ConversationEnvelope = {
  content: '把这轮放到云端跑',
  sessionId,
  clientMessageId: 'client-msg-env-protocol',
};

function renderSendHook() {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: sessionId,
    currentTurnMessageIdRef: { current: null },
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

function assistantMessages() {
  return useSessionStore.getState().messages.filter((message) => message.role === 'assistant');
}

describe('useAgentIPC 发送失败 → ENVIRONMENT_PROTOCOL_UNSUPPORTED 文案', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeDomainMock.mockReset();
    useSessionStore.setState({
      currentSessionId: sessionId,
      messages: [],
    });
    useSwarmStore.getState().reset();
    useAppStore.setState({
      isProcessing: false,
      processingSessionIds: new Set<string>(),
      language: 'zh',
    });
    useTaskStore.setState({
      sessionStates: {
        [sessionId]: { status: 'idle' },
      },
    });
  });

  it('④ zh：失败气泡给 ADR 原句，不透传原始报错', async () => {
    invokeMock.mockRejectedValueOnce(protocolRejection());
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const assistants = assistantMessages();
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe(environmentProtocolUnsupportedMessage(protocolRejection(), 'zh'));
    expect(assistants[0]?.content).not.toContain('云端代理请求失败');
  });

  it('④ en：跟随界面语言给英文句', async () => {
    useAppStore.setState({ language: 'en' });
    invokeMock.mockRejectedValueOnce(protocolRejection());
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const assistants = assistantMessages();
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe(environmentProtocolUnsupportedMessage(protocolRejection(), 'en'));
  });

  it('其他发送错误不误伤：无稳定码时仍走原始报错路径', async () => {
    invokeMock.mockRejectedValueOnce(new Error('network down'));
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const assistants = assistantMessages();
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe('Error: network down');
  });
});
