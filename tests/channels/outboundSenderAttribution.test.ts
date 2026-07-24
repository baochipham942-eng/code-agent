// ============================================================================
// 出站消息发信人归属前缀 (withSenderAttribution)
// 多人同群使唤同一 bot 时，回帖前加 `[<发起人名字>] ` 前缀便于区分回给谁；
// 私聊不加；名字缺失/解析失败降级为不加前缀，绝不阻断发送。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { withSenderAttribution } from '../../src/host/channels/channelAgentBridge';
import type { ChannelMessage } from '../../src/shared/contract/channel';

function makeMessage(overrides: {
  chatType: 'p2p' | 'group' | 'channel';
  senderName?: string;
}): ChannelMessage {
  return {
    id: 'msg-1',
    channelId: 'feishu',
    sender: { id: 'ou_1', name: overrides.senderName ?? '张三' },
    context: { chatId: 'oc_1', chatType: overrides.chatType },
    content: '你好',
    timestamp: Date.now(),
  } as ChannelMessage;
}

describe('withSenderAttribution', () => {
  it('群聊：加 [发起人名字] 前缀', () => {
    const message = makeMessage({ chatType: 'group', senderName: '张三' });
    expect(withSenderAttribution(message, '收到')).toBe('[张三] 收到');
  });

  it('私聊(p2p)：不加前缀', () => {
    const message = makeMessage({ chatType: 'p2p', senderName: '张三' });
    expect(withSenderAttribution(message, '收到')).toBe('收到');
  });

  it('群聊但发起人名字缺失(空字符串)：降级不加前缀', () => {
    const message = makeMessage({ chatType: 'group', senderName: '' });
    expect(withSenderAttribution(message, '收到')).toBe('收到');
  });

  it('群聊但发起人名字为纯空白：降级不加前缀', () => {
    const message = makeMessage({ chatType: 'group', senderName: '   ' });
    expect(withSenderAttribution(message, '收到')).toBe('收到');
  });

  it('群聊但 sender 整体缺失：降级不加前缀，不抛异常', () => {
    const message = {
      id: 'msg-1',
      channelId: 'feishu',
      sender: undefined,
      context: { chatId: 'oc_1', chatType: 'group' },
      content: '你好',
      timestamp: Date.now(),
    } as unknown as ChannelMessage;
    expect(() => withSenderAttribution(message, '收到')).not.toThrow();
    expect(withSenderAttribution(message, '收到')).toBe('收到');
  });
});
