import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';

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

  it('没有锚点时保持原行为：往回找最近的 user 消息', () => {
    install([
      { id: 'u-a', role: 'user', content: '问题 A', timestamp: 1 },
      { id: 'a-a', role: 'assistant', content: 'A 的回答', timestamp: 2 },
    ]);

    useMessageActionStore.getState().regenerateLast();

    expect(send.mock.calls[0][0]).toBe('问题 A');
  });
});
