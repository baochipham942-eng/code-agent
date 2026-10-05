import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage, FeishuChannelConfig } from '../../../src/shared/contract/channel';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import { setChannelListenResolver } from '../../../src/host/channels/channelListenRegistry';
import type { ChannelResponseCallback } from '../../../src/host/channels/channelInterface';

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [
    { name: 'Read', permissionLevel: 'read', source: 'builtin' },
    { name: 'Bash', permissionLevel: 'execute', source: 'builtin' },
    { name: 'BrowserNavigate', permissionLevel: 'read', source: 'builtin' },
    { name: 'ComputerUse', permissionLevel: 'read', source: 'builtin' },
    { name: 'Write', permissionLevel: 'write', source: 'builtin' },
    { name: 'mcp__demo__read', permissionLevel: 'read', source: 'mcp' },
    { name: 'CronCreate', permissionLevel: 'read', source: 'builtin' },
    { name: 'delegate_task', permissionLevel: 'read', source: 'builtin' },
  ],
}));

type Harness = {
  handleMessageEvent(event: unknown): Promise<void>;
  botOpenId: string | null;
  client: unknown;
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

function event(options: { chatType: 'p2p' | 'group'; mentioned?: boolean; id?: string }): unknown {
  return {
    message: {
      message_id: options.id ?? 'om_1',
      create_time: '1800000000000',
      chat_id: 'oc_chat',
      chat_type: options.chatType,
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      mentions: options.mentioned ? [{ key: '@Aix', id: { open_id: 'ou_bot' }, name: 'Aix' }] : [],
    },
    sender: {
      sender_id: { open_id: 'ou_sender', user_id: 'sender' },
      sender_type: 'user',
    },
  };
}

async function drive(config: Partial<FeishuChannelConfig>, input: unknown) {
  const channel = new FeishuChannel('feishu-account');
  const messages: ChannelMessage[] = [];
  const listenMessages: ChannelMessage[] = [];
  const pairings: unknown[] = [];
  const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply' } }));
  channel.on('message', (message: ChannelMessage) => messages.push(message));
  channel.on('listen_message', (message: ChannelMessage) => listenMessages.push(message));
  channel.on('pairing_request', (pairing: unknown) => pairings.push(pairing));
  await channel.initialize({
    type: 'feishu', appId: 'app', appSecret: 'secret', ...config,
  });
  const harness = channel as unknown as Harness;
  harness.botOpenId = 'ou_bot';
  harness.client = { im: { message: { create } } };
  await harness.handleMessageEvent(input);
  return { messages, listenMessages, pairings, create };
}

describe('Feishu ingress access', () => {
  afterEach(() => {
    setChannelListenResolver(undefined);
  });

  it('drops an unpaired direct message and emits a pairing request', async () => {
    const result = await drive({}, event({ chatType: 'p2p' }));
    expect(result.messages).toHaveLength(0);
    expect(result.pairings).toEqual([expect.objectContaining({ senderId: 'ou_sender', chatId: 'oc_chat' })]);
  });

  it('allows a paired sender into a paired session', async () => {
    const result = await drive({ inboundAllowlist: ['ou_sender'] }, event({ chatType: 'p2p' }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ingressAuth).toBe('paired');
  });

  it('drops a group message that does not mention the bot', async () => {
    const result = await drive(
      { inboundAllowlist: ['ou_sender'], groupAccessMode: 'all_members' },
      event({ chatType: 'group', mentioned: false }),
    );
    expect(result.messages).toHaveLength(0);
    expect(result.listenMessages).toHaveLength(0);
  });

  it('emits an un-mentioned group message as listen_message only when a listen binding exists', async () => {
    // ② 显式绑定：未 @ 的群消息只走 listen_message，永不走 message。
    setChannelListenResolver(() => true);
    const result = await drive(
      { inboundAllowlist: ['ou_sender'], groupAccessMode: 'allowlist' },
      event({ chatType: 'group', mentioned: false, id: 'om_listen' }),
    );
    expect(result.listenMessages).toHaveLength(1);
    expect(result.messages).toHaveLength(0);
    expect(result.pairings).toHaveLength(0);
    expect(result.create).not.toHaveBeenCalled();
    const listenMessage = result.listenMessages[0];
    expect(listenMessage.id).toBe('om_listen');
    expect(listenMessage.context).toMatchObject({ chatId: 'oc_chat', chatType: 'group' });
    expect(listenMessage.content).toBe('hello');
    // 监听消息不带 auth 档：既非 paired 也非 guest。
    expect(listenMessage.ingressAuth).toBeUndefined();
  });

  it('resolves the listen binding per (accountId, chatId)', async () => {
    setChannelListenResolver((accountId, chatId) => accountId === 'feishu-account' && chatId === 'oc_chat');
    const otherChat = JSON.parse(JSON.stringify(event({ chatType: 'group', mentioned: false, id: 'om_other' })));
    otherChat.message.chat_id = 'oc_other';
    const miss = await drive({ groupAccessMode: 'allowlist' }, otherChat);
    expect(miss.listenMessages).toHaveLength(0);
    expect(miss.messages).toHaveLength(0);
  });

  it('keeps denying un-mentioned messages in a disabled group even with a listen binding', async () => {
    setChannelListenResolver(() => true);
    const result = await drive(
      { inboundAllowlist: ['ou_sender'], groupAccessMode: 'disabled' },
      event({ chatType: 'group', mentioned: false, id: 'om_disabled_listen' }),
    );
    expect(result.messages).toHaveLength(0);
    expect(result.listenMessages).toHaveLength(0);
  });

  it('still emits message (not listen_message) for an @-mentioned group message with a listen binding present', async () => {
    setChannelListenResolver(() => true);
    const result = await drive(
      { inboundAllowlist: ['ou_sender'] },
      event({ chatType: 'group', mentioned: true, id: 'om_mentioned' }),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ingressAuth).toBe('paired');
    expect(result.listenMessages).toHaveLength(0);
  });

  it('enforces disabled and allowlist group modes', async () => {
    const disabled = await drive(
      { inboundAllowlist: ['ou_sender'], groupAccessMode: 'disabled' },
      event({ chatType: 'group', mentioned: true, id: 'om_disabled' }),
    );
    const allowlist = await drive(
      { groupAccessMode: 'allowlist', inboundLocale: 'en-US' },
      event({ chatType: 'group', mentioned: true, id: 'om_allowlist' }),
    );
    expect(disabled.messages).toHaveLength(0);
    expect(allowlist.messages).toHaveLength(0);
    expect(allowlist.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: expect.stringContaining('Unauthorized') }),
    }));
  });

  it('routes all_members through a guest session with a physically cropped tool table', async () => {
    const allMembers = await drive(
      { groupAccessMode: 'all_members' },
      event({ chatType: 'group', mentioned: true, id: 'om_guest' }),
    );

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
      'feishu-account',
      allMembers.messages[0],
      orchestrator,
      undefined,
      { sendText: vi.fn(async () => ({ success: true })) },
    );
    expect(allMembers.messages).toHaveLength(1);
    expect(allowedToolNames).toEqual(['Read']);
    expect(allMembers.messages[0].ingressAuth).toBe('guest');
  });
});
