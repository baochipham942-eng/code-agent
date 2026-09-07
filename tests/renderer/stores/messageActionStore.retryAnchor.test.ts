import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

// ai-review #1694：发送失败会把乐观用户消息从时间线撤掉（防重复提交）。
// 重试锚点必须跟着走，否则 regenerateMessage 往回找会命中**上一轮**的提问。
describe('regenerate 的重试锚点', () => {
  const send = vi.fn();

  const install = (messages: Message[]) => {
    useMessageActionStore.getState().register(send, () => messages);
  };

  beforeEach(() => {
    send.mockClear();
    useMessageActionStore.getState().unregister();
  });

  const errorWithAnchor = (retryPrompt: string): Message => ({
    id: 'err-1',
    role: 'assistant',
    content: '发送失败',
    timestamp: 3,
    metadata: { retryPrompt },
  });

  it('错误消息带 retryPrompt 时重发的是失败那条，不是上一轮', () => {
    install([
      { id: 'u-a', role: 'user', content: '问题 A', timestamp: 1 },
      { id: 'a-a', role: 'assistant', content: 'A 的回答', timestamp: 2 },
      errorWithAnchor('问题 B'),
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('问题 B');
    expect(send.mock.calls[0][0]).not.toBe('问题 A');
  });

  it('首条消息就失败时仍可重试（往回找一条 user 都没有）', () => {
    install([errorWithAnchor('第一句话')]);

    useMessageActionStore.getState().regenerateLast();

    expect(send.mock.calls[0][0]).toBe('第一句话');
  });

  // ai-review #1694 第四轮①：只带文本 = 用户点重试就把文件丢了。
  it('锚点里的附件也要一起重发', () => {
    const attachment = { id: 'f1', name: 'a.png', type: 'image', size: 1, data: 'x' } as never;
    install([
      {
        id: 'err-att',
        role: 'assistant',
        content: '发送失败',
        timestamp: 3,
        metadata: { retryPrompt: '带附件的问题', retryAttachments: [attachment] },
      },
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send.mock.calls[0][0]).toBe('带附件的问题');
    expect(send.mock.calls[0][1]).toEqual({ attachments: [attachment] });
  });

  // ai-review #1694 第五轮①：纯附件消息（图片直发无文字）也要留锚点。
  it('纯附件消息（retryPrompt 为空串）也能重试', () => {
    const attachment = { id: 'f2', name: 'b.png', type: 'image', size: 1, data: 'y' } as never;
    install([
      {
        id: 'err-only-att',
        role: 'assistant',
        content: '发送失败',
        timestamp: 3,
        metadata: { retryPrompt: '', retryAttachments: [attachment] },
      },
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ attachments: [attachment] });
  });

  // ai-review #1694 第六轮：错误消息会落到**当下**的会话上，锚点不绑会话就会把
  // A 的内容重发进 B。
  it('锚点属于别的会话时不用它（回落到往回找）', () => {
    useSessionStore.setState({ currentSessionId: 'session-B' } as never);
    install([
      { id: 'u-b', role: 'user', content: 'B 会话的问题', timestamp: 1 },
      {
        id: 'err-cross',
        role: 'assistant',
        content: '发送失败',
        timestamp: 3,
        metadata: { retryPrompt: 'A 会话的问题', retrySessionId: 'session-A' },
      },
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send.mock.calls[0][0]).toBe('B 会话的问题');
    expect(send.mock.calls[0][0]).not.toBe('A 会话的问题');
  });

  it('锚点会话与当前一致时照常用锚点', () => {
    useSessionStore.setState({ currentSessionId: 'session-A' } as never);
    install([
      { id: 'u-b', role: 'user', content: '上一轮', timestamp: 1 },
      {
        id: 'err-same',
        role: 'assistant',
        content: '发送失败',
        timestamp: 3,
        metadata: { retryPrompt: 'A 会话的问题', retrySessionId: 'session-A' },
      },
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send.mock.calls[0][0]).toBe('A 会话的问题');
  });

  it('没有锚点时保持原行为：往回找最近的 user 消息', () => {
    install([
      { id: 'u-a', role: 'user', content: '问题 A', timestamp: 1 },
      { id: 'a-a', role: 'assistant', content: 'A 的回答', timestamp: 2 },
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send.mock.calls[0][0]).toBe('问题 A');
  });
});
