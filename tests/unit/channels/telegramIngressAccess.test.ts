// Telegram 入站准接到消息的端到端 pin（N-TELEGRAM-INBOUND-FAILOPEN）：
// 陌生人消息带 ingressAuth='guest' 发出，经 ChannelAgentBridge 时工具表被物理裁剪；
// 群未 @ 丢弃；回复 bot 的群消息以访客档放行；名单身份仍 paired。
import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage, TelegramChannelConfig } from '../../../src/shared/contract/channel';
import { TelegramChannel } from '../../../src/host/channels/telegram/telegramChannel';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import type { ChannelResponseCallback } from '../../../src/host/channels/channelInterface';

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [
    { name: 'Read', permissionLevel: 'read', source: 'builtin' },
    { name: 'Bash', permissionLevel: 'execute', source: 'builtin' },
    { name: 'Write', permissionLevel: 'write', source: 'builtin' },
  ],
}));

type Harness = {
  handleTextMessage(ctx: unknown): Promise<void>;
  bot: unknown;
};

type BridgeHarness = {
  handleSyncMessage(
    accountId: string,
    message: ChannelMessage,
    orchestrator: unknown,
    attachments: undefined,
    responseCallback: ChannelResponseCallback,
  ): Promise<void>;
};

const BOT = { id: 100, username: 'NeoBot' };

function ctx(options: {
  chatType: 'private' | 'group';
  mention?: boolean;
  replyToBot?: boolean;
  senderId?: number;
  chatId?: number;
}): unknown {
  const text = options.mention ? '@NeoBot 在吗' : '随便聊聊';
  return {
    message: {
      message_id: 1,
      date: 1800000000,
      text,
      entities: options.mention ? [{ type: 'mention', offset: 0, length: 7 }] : [],
      reply_to_message: options.replyToBot ? { from: { id: BOT.id } } : undefined,
    },
    from: { id: options.senderId ?? 42, is_bot: false, username: 'stranger', first_name: 'S' },
    chat: {
      id: options.chatId ?? 9,
      type: options.chatType,
      title: options.chatType === 'group' ? '测试群' : undefined,
    },
  };
}

async function drive(config: Partial<TelegramChannelConfig>, input: unknown) {
  const channel = new TelegramChannel('telegram-account');
  const messages: ChannelMessage[] = [];
  channel.on('message', (message: ChannelMessage) => messages.push(message));
  await channel.initialize({ type: 'telegram', botToken: 'test-token', ...config });
  const harness = channel as unknown as Harness;
  harness.bot = { botInfo: BOT };
  await harness.handleTextMessage(input);
  return { messages };
}

describe('Telegram ingress access', () => {
  it('emits an unknown private sender as guest and the bridge physically crops the tool table', async () => {
    const result = await drive({}, ctx({ chatType: 'private' }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ingressAuth).toBe('guest');

    let allowedToolNames: string[] | undefined;
    const orchestrator = {
      getMessages: vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ role: 'assistant', content: 'done' }]),
      sendMessage: vi.fn(async (
        _content: string,
        _attachments: unknown,
        options: { allowedToolNames?: string[] } | undefined,
      ) => { allowedToolNames = options?.allowedToolNames; }),
    };
    const bridge = new ChannelAgentBridge({ configService: {} as never }) as unknown as BridgeHarness;
    await bridge.handleSyncMessage(
      'telegram-account',
      result.messages[0],
      orchestrator,
      undefined,
      { sendText: vi.fn(async () => ({ success: true })) },
    );
    expect(allowedToolNames).toEqual(['Read']);
  });

  it('drops a group message that neither mentions nor replies to the bot', async () => {
    const result = await drive({}, ctx({ chatType: 'group' }));
    expect(result.messages).toHaveLength(0);
  });

  it('admits a group reply to the bot from an unknown sender as guest', async () => {
    const result = await drive({}, ctx({ chatType: 'group', replyToBot: true }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ingressAuth).toBe('guest');
  });

  it('keeps an allowlisted sender paired', async () => {
    const result = await drive({ allowedUserIds: [42] }, ctx({ chatType: 'private' }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ingressAuth).toBe('paired');
  });

  it('admits any group member without a mention as guest under all_members mode', async () => {
    const result = await drive({ groupAccessMode: 'all_members' }, ctx({ chatType: 'group' }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ingressAuth).toBe('guest');
  });
});
