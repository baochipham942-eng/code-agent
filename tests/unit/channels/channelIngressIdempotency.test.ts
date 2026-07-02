// ============================================================================
// WP3-2 IM 入站幂等契约：
// - BoundedDedupeSet：有界去重集（防内存无界增长），判定不了当新消息（不吞消息）
// - feishu：webhook event_id 重推 / handleMessageEvent message_id 重放 → 只 emit 一次
//   （三条入站路径 webhook/EventDispatcher/WebSocket 在 handleMessageEvent 收口）
// - telegram：同 update_id 重放 → 只 emit 一次（对称应用）
// - bridge processedMessages：容量有界（此前仅 TTL 无上界）
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { BoundedDedupeSet } from '../../../src/host/channels/inboundDedupe';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';
import { TelegramChannel } from '../../../src/host/channels/telegram/telegramChannel';
import { CHANNEL_INGRESS } from '../../../src/shared/constants';
import type { ChannelMessage } from '../../../src/shared/contract/channel';

describe('BoundedDedupeSet', () => {
  it('首见返回 true，重复返回 false', () => {
    const set = new BoundedDedupeSet(10);
    expect(set.markSeen('a')).toBe(true);
    expect(set.markSeen('a')).toBe(false);
    expect(set.markSeen('b')).toBe(true);
  });

  it('容量有界：超界逐出最旧，被逐出的 id 再见视为新（防内存涨优先于极端场景查重）', () => {
    const set = new BoundedDedupeSet(2);
    set.markSeen('a');
    set.markSeen('b');
    set.markSeen('c'); // 逐出 a
    expect(set.markSeen('a')).toBe(true);
    expect(set.markSeen('c')).toBe(false);
  });
});

// ---- feishu：message_id 幂等（handleMessageEvent 收口，覆盖三条入站路径）----

type FeishuHarness = FeishuChannel & {
  handleMessageEvent(event: unknown): Promise<void>;
  webhookServer?: Server | null;
};

function createFeishuTextEvent(messageId: string, text = 'hello'): unknown {
  return {
    message: {
      message_id: messageId,
      root_id: '',
      parent_id: '',
      create_time: '1800000000000',
      chat_id: 'oc_chat_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [],
    },
    sender: {
      sender_id: { open_id: 'ou_sender', user_id: 'sender_user' },
      sender_type: 'user',
    },
  };
}

async function makeFeishuChannel(): Promise<{ channel: FeishuChannel; emitted: ChannelMessage[] }> {
  const channel = new FeishuChannel('feishu-idem');
  const emitted: ChannelMessage[] = [];
  channel.on('message', (m: ChannelMessage) => emitted.push(m));
  await channel.initialize({ type: 'feishu', appId: 'cli_test', appSecret: 'secret_test' });
  return { channel, emitted };
}

describe('feishu 入站 message_id 幂等', () => {
  it('同 message_id 重放 → 只 emit 一次', async () => {
    const { channel, emitted } = await makeFeishuChannel();
    const harness = channel as unknown as FeishuHarness;
    await harness.handleMessageEvent(createFeishuTextEvent('om_dup_1'));
    await harness.handleMessageEvent(createFeishuTextEvent('om_dup_1'));
    await channel.destroy();
    expect(emitted).toHaveLength(1);
  });

  it('不同 message_id → 各自 emit', async () => {
    const { channel, emitted } = await makeFeishuChannel();
    const harness = channel as unknown as FeishuHarness;
    await harness.handleMessageEvent(createFeishuTextEvent('om_a'));
    await harness.handleMessageEvent(createFeishuTextEvent('om_b'));
    await channel.destroy();
    expect(emitted).toHaveLength(2);
  });

  it('webhook 同 event_id 重推（3s 未回 200 场景）→ 只处理一次，两次都回 200 ack', async () => {
    const channel = new FeishuChannel('feishu-webhook-idem');
    const emitted: ChannelMessage[] = [];
    channel.on('message', (m: ChannelMessage) => emitted.push(m));
    await channel.initialize({
      type: 'feishu',
      appId: 'cli_test',
      appSecret: 'secret_test',
      webhookHost: '127.0.0.1',
      webhookPort: 0,
    });
    await channel.connect();
    try {
      const server = (channel as unknown as FeishuHarness).webhookServer;
      const address = server?.address() as AddressInfo | null;
      expect(address?.port).toBeGreaterThan(0);
      const body = JSON.stringify({
        schema: '2.0',
        header: { event_id: 'evt_repush_1', event_type: 'im.message.receive_v1' },
        event: createFeishuTextEvent('om_webhook_1'),
      });
      const post = () =>
        fetch(`http://127.0.0.1:${address!.port}/webhook/feishu`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
      const r1 = await post();
      const r2 = await post();
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200); // 重推必须 ack，否则飞书会继续重推
      expect(emitted).toHaveLength(1);
    } finally {
      await channel.destroy();
    }
  });
});

// ---- telegram：update_id 幂等（对称应用）----

type TelegramHarness = TelegramChannel & {
  handleTextMessage(ctx: unknown): Promise<void>;
};

function makeTelegramCtx(updateId: number, messageId: number, text = 'hi'): unknown {
  const from = { id: 42, is_bot: false, first_name: 'U', username: 'u42' };
  const chat = { id: 99, type: 'private' as const };
  return {
    update: { update_id: updateId },
    message: { message_id: messageId, text, date: 1700000000, chat, from },
    from,
    chat,
  };
}

async function makeTelegramChannel(): Promise<{ channel: TelegramChannel; emitted: ChannelMessage[] }> {
  const channel = new TelegramChannel('tg-idem');
  const emitted: ChannelMessage[] = [];
  channel.on('message', (m: ChannelMessage) => emitted.push(m));
  await channel.initialize({ type: 'telegram', botToken: 'test-token' });
  return { channel, emitted };
}

describe('telegram 入站 update_id 幂等', () => {
  it('同 update_id 重放 → 只 emit 一次', async () => {
    const { channel, emitted } = await makeTelegramChannel();
    const harness = channel as unknown as TelegramHarness;
    await harness.handleTextMessage(makeTelegramCtx(1001, 501));
    await harness.handleTextMessage(makeTelegramCtx(1001, 501));
    expect(emitted).toHaveLength(1);
  });

  it('不同 update_id → 各自 emit', async () => {
    const { channel, emitted } = await makeTelegramChannel();
    const harness = channel as unknown as TelegramHarness;
    await harness.handleTextMessage(makeTelegramCtx(1001, 501));
    await harness.handleTextMessage(makeTelegramCtx(1002, 502));
    expect(emitted).toHaveLength(2);
  });
});

// ---- bridge processedMessages：容量有界 ----

describe('ChannelAgentBridge processedMessages 有界', () => {
  it('超容量上界逐出最旧，Map 尺寸不越界（防内存涨）', async () => {
    vi.resetModules();
    const { ChannelAgentBridge } = await import('../../../src/host/channels/channelAgentBridge');
    const bridge = new ChannelAgentBridge({ configService: {} as never });
    const harness = bridge as unknown as {
      markMessageProcessing(accountId: string, messageId: string): boolean;
      processedMessages: Map<string, unknown>;
    };
    const cap = CHANNEL_INGRESS.PROCESSED_MESSAGES_MAX;
    for (let i = 0; i < cap + 50; i++) {
      expect(harness.markMessageProcessing('acc', `m-${i}`)).toBe(true);
    }
    expect(harness.processedMessages.size).toBeLessThanOrEqual(cap);
    // 仍在窗口内的近期消息保持去重语义
    expect(harness.markMessageProcessing('acc', `m-${cap + 49}`)).toBe(false);
  });
});
