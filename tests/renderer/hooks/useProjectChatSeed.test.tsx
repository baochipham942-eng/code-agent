// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import {
  rollbackProjectChatSeedMessage,
  useProjectChatSeedConsumption,
} from '../../../src/renderer/components/features/chat/useProjectChatSeed';
import { useProjectChatSeedStore } from '../../../src/renderer/stores/projectChatSeedStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const SEED_SESSION = 'sess-seed';
const OPTIMISTIC_ID = 'optimistic-1';

function makeEnvelope(overrides: Partial<ConversationEnvelope> = {}): ConversationEnvelope {
  return {
    content: '帮我整理这个项目的周报',
    clientMessageId: OPTIMISTIC_ID,
    ...overrides,
  };
}

function Harness(props: {
  currentSessionId: string | null;
  effectiveIsProcessing: boolean;
  handleSendEnvelope: (envelope: ConversationEnvelope) => Promise<boolean>;
}) {
  useProjectChatSeedConsumption(props);
  return null;
}

function seedStore(envelope: ConversationEnvelope = makeEnvelope()) {
  useProjectChatSeedStore.setState({ pendingProjectChatSeed: { sessionId: SEED_SESSION, envelope } });
}

beforeEach(() => {
  useProjectChatSeedStore.setState({ pendingProjectChatSeed: null });
  useSessionStore.setState({
    currentSessionId: SEED_SESSION,
    messages: [
      { id: OPTIMISTIC_ID, role: 'user', content: '帮我整理这个项目的周报', timestamp: 1 },
    ],
  } as never);
});

afterEach(() => {
  cleanup();
  useProjectChatSeedStore.setState({ pendingProjectChatSeed: null });
});

describe('useProjectChatSeedConsumption —— seed 进行中态', () => {
  it('目标会话就绪：完整 envelope 交给 handleSendEnvelope 并清 seed', async () => {
    const handleSendEnvelope = vi.fn().mockResolvedValue(true);
    const envelope = makeEnvelope({ attachments: [{ id: 'att-1' } as never] });
    seedStore(envelope);
    render(<Harness currentSessionId={SEED_SESSION} effectiveIsProcessing={false} handleSendEnvelope={handleSendEnvelope} />);

    await waitFor(() => expect(handleSendEnvelope).toHaveBeenCalledWith(envelope));
    expect(useProjectChatSeedStore.getState().pendingProjectChatSeed).toBeNull();
    // 发送成功：乐观消息保留在时间线上（sendMessage 按 id 去重，不双份也不回滚）
    expect(useSessionStore.getState().messages.some((message) => message.id === OPTIMISTIC_ID)).toBe(true);
  });

  it('sessionId 不匹配（窗口不是目标会话）：不消费', async () => {
    const handleSendEnvelope = vi.fn().mockResolvedValue(true);
    seedStore();
    render(<Harness currentSessionId="sess-other" effectiveIsProcessing={false} handleSendEnvelope={handleSendEnvelope} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleSendEnvelope).not.toHaveBeenCalled();
    expect(useProjectChatSeedStore.getState().pendingProjectChatSeed).not.toBeNull();
  });

  it('会话正在处理中：等处理完再消费', async () => {
    const handleSendEnvelope = vi.fn().mockResolvedValue(true);
    seedStore();
    const { rerender } = render(
      <Harness currentSessionId={SEED_SESSION} effectiveIsProcessing handleSendEnvelope={handleSendEnvelope} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleSendEnvelope).not.toHaveBeenCalled();

    rerender(<Harness currentSessionId={SEED_SESSION} effectiveIsProcessing={false} handleSendEnvelope={handleSendEnvelope} />);
    await waitFor(() => expect(handleSendEnvelope).toHaveBeenCalled());
  });

  it('发送失败（返回 false）：回滚乐观消息，时间线不留没发出去的话', async () => {
    const handleSendEnvelope = vi.fn().mockResolvedValue(false);
    seedStore();
    render(<Harness currentSessionId={SEED_SESSION} effectiveIsProcessing={false} handleSendEnvelope={handleSendEnvelope} />);

    await waitFor(() => expect(handleSendEnvelope).toHaveBeenCalled());
    await waitFor(() =>
      expect(useSessionStore.getState().messages.some((message) => message.id === OPTIMISTIC_ID)).toBe(false),
    );
  });

  it('发送抛错：同样回滚乐观消息', async () => {
    const handleSendEnvelope = vi.fn().mockRejectedValue(new Error('send failed'));
    seedStore();
    render(<Harness currentSessionId={SEED_SESSION} effectiveIsProcessing={false} handleSendEnvelope={handleSendEnvelope} />);

    await waitFor(() => expect(handleSendEnvelope).toHaveBeenCalled());
    await waitFor(() =>
      expect(useSessionStore.getState().messages.some((message) => message.id === OPTIMISTIC_ID)).toBe(false),
    );
  });

  it('rollbackProjectChatSeedMessage：无 clientMessageId 不动时间线', () => {
    act(() => rollbackProjectChatSeedMessage(undefined));
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
