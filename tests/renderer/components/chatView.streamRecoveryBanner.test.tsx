// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment, StreamRecoverySnapshot } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { deriveRetryTurnMessage, StreamRecoveryBanner } from '../../../src/renderer/components/ChatView';

function makeSnapshot(overrides: Partial<StreamRecoverySnapshot> = {}): StreamRecoverySnapshot {
  return {
    sessionId: 'session-1',
    turnId: 'turn-abc',
    content: '部分回复内容',
    reasoning: '',
    toolCalls: [],
    estimatedTokens: 10,
    timestamp: Date.now(),
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
    ...overrides,
  };
}

function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-user-1',
    role: 'user',
    content: '帮我写个函数',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAssistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: '好的，我来写',
    timestamp: Date.now(),
    ...overrides,
  };
}

// D-1：streamSnapshot 没有任何字段指回触发它的用户消息（turnId 是每轮现铸的 UUID，
// 与消息 id 无关联）。锚点靠结构性推导——只要 snapshot 还在，addMessage 必然还没被
// 调用过（它无条件清空 snapshot），中断的助手回复也从没落进 messages，所以末位消息
// 就是触发这轮的用户消息。deriveRetryTurnMessage 是这条推导本身，抽成纯函数单独钉，
// 不许再让它裸奔在 ChatView 函数体里靠喂 Banner props 间接测。
describe('deriveRetryTurnMessage — 锚点推导', () => {
  it('末位是 user 消息：返回该消息', () => {
    const userMsg = makeUserMessage();
    expect(deriveRetryTurnMessage(makeSnapshot(), [makeAssistantMessage({ id: 'old' }), userMsg])).toBe(userMsg);
  });

  it('末位不是 user 消息（是 assistant）：返回 null，不许瞎重发助手消息', () => {
    const messages = [makeUserMessage(), makeAssistantMessage()];
    expect(deriveRetryTurnMessage(makeSnapshot(), messages)).toBeNull();
  });

  it('messages 为空：返回 null', () => {
    expect(deriveRetryTurnMessage(makeSnapshot(), [])).toBeNull();
  });

  it('streamSnapshot 为 null：返回 null（即便 messages 末位是 user）', () => {
    expect(deriveRetryTurnMessage(null, [makeUserMessage()])).toBeNull();
  });
});

afterEach(cleanup);

describe('StreamRecoveryBanner — 重试该轮', () => {
  it('有 retryMessage 时渲染重试按钮，点击以原始消息内容+附件调用 onSend', async () => {
    const attachment: MessageAttachment = {
      id: 'att-1',
      type: 'image',
      category: 'image',
      name: 'a.png',
      size: 1024,
      mimeType: 'image/png',
      path: '/tmp/a.png',
    };
    const message = makeUserMessage({ content: '帮我写个函数', attachments: [attachment] });
    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <StreamRecoveryBanner snapshot={makeSnapshot()} retryMessage={message} onSend={onSend} />,
    );

    const button = screen.getByRole('button', { name: '重试该轮' });
    fireEvent.click(button);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // 断言第二参数就是原消息的附件数组——附件能原样带上是这一刀的卖点之一，得钉住。
    expect(onSend).toHaveBeenCalledWith('帮我写个函数', [attachment]);
  });

  it('retryMessage 为 null（找不到原始用户消息锚点）时不渲染重试按钮', () => {
    const onSend = vi.fn();
    const { container } = render(
      <StreamRecoveryBanner snapshot={makeSnapshot()} retryMessage={null} onSend={onSend} />,
    );

    // 结构性断言：查按钮节点是否存在，不是查文本有没有出现在页面某处。
    expect(screen.queryByRole('button', { name: '重试该轮' })).toBeNull();
    // dismiss 按钮（唯一按钮）仍在，证明横幅本体照常渲染，只是少了重试按钮这一个节点。
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('重试进行中：按钮 disabled，文案切到「重试中…」', async () => {
    let resolveSend: (value: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve; }));
    const message = makeUserMessage();
    render(
      <StreamRecoveryBanner snapshot={makeSnapshot()} retryMessage={message} onSend={onSend} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重试该轮' }));

    const button = await screen.findByRole('button', { name: '重试中…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    resolveSend(true);
    await waitFor(() => expect(screen.getByRole('button', { name: '重试该轮' })).toBeTruthy());
  });
});
