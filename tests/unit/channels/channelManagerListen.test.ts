// ============================================================================
// ChannelManager 'listen_message' 转发测试（N-TRIGGER-GROUP-LISTEN 验收②）
// ----------------------------------------------------------------------------
// 监听事件在管理器层只做一件事：原样转发 (accountId, message)。不进收件箱
// （recordInboundMessage / inbox_changed 都不该发生）、不调 messageHandler
// （agent 桥经 setMessageHandler 注入 —— 不调它 = 桥永远不回话）。
// 用假通道插件（EventEmitter + 空 lifecycle）驱动真 ChannelManager 单例，
// 不出网、不碰真机。
// ============================================================================
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAccountConfig,
  ChannelMessage,
} from '../../../src/shared/contract/channel';
import { ChannelManager } from '../../../src/host/channels/channelManager';
import type { IChannelPlugin } from '../../../src/host/channels/channelInterface';

function fakeMessage(id: string): ChannelMessage {
  return {
    id,
    channelId: 'acc-listen',
    sender: { id: 'ou_sender', name: 'sender' },
    context: { chatId: 'oc_chat', chatType: 'group' },
    content: `listen ${id}`,
    timestamp: 1_800_000_000_000,
  };
}

const FAKE_FEISHU_META = {
  type: 'feishu',
  name: 'Fake Feishu',
  description: 'fake',
  capabilities: {},
} as never;

class FakeChannel extends EventEmitter implements IChannelPlugin {
  readonly meta = FAKE_FEISHU_META;
  status = 'disconnected' as const;
  constructor(readonly accountId: string) {
    super();
  }
  async initialize(_config: ChannelAccountConfig): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async destroy(): Promise<void> {}
  async sendMessage(): Promise<{ success: true }> {
    return { success: true };
  }
}

describe('ChannelManager listen_message wiring', () => {
  let manager: ChannelManager;
  let fakeChannel: FakeChannel;
  let accountId: string;
  const managerMessages: ChannelMessage[] = [];
  const listenEvents: Array<{ accountId: string; message: ChannelMessage }> = [];
  const inboxChanges: number[] = [];
  const handler = vi.fn(async () => {});

  const onManagerMessage = (message: ChannelMessage) => managerMessages.push(message);
  const onListenMessage = (id: string, message: ChannelMessage) => listenEvents.push({ accountId: id, message });
  const onInboxChanged = () => inboxChanges.push(manager.getInboxItems().length);
  const noopHandler = async () => {};

  beforeEach(async () => {
    manager = ChannelManager.getInstance();
    // 用假工厂顶掉内置 feishu 注册（本文件内的所有连接都走假通道）。
    manager.registerPlugin({
      type: 'feishu',
      meta: FAKE_FEISHU_META,
      factory: (id: string) => {
        fakeChannel = new FakeChannel(id);
        return fakeChannel;
      },
    });
    const account = await manager.addAccount('listen-test', 'feishu', {
      type: 'feishu', appId: 'app', appSecret: 'secret',
    });
    accountId = account.id;
    await manager.connectAccount(accountId);
    manager.on('message', onManagerMessage);
    manager.on('listen_message', onListenMessage);
    manager.on('inbox_changed', onInboxChanged);
    manager.setMessageHandler(handler);
  });

  afterEach(async () => {
    manager.off('message', onManagerMessage);
    manager.off('listen_message', onListenMessage);
    manager.off('inbox_changed', onInboxChanged);
    await manager.disconnectAccount(accountId);
    await manager.deleteAccount(accountId);
    manager.setMessageHandler(noopHandler);
  });

  it('re-emits listen_message only: no inbox item, no messageHandler, no message event', () => {
    fakeChannel.emit('listen_message', fakeMessage('om_listen_1'));

    expect(listenEvents).toHaveLength(1);
    expect(listenEvents[0].accountId).toBe(accountId);
    expect(listenEvents[0].message.id).toBe('om_listen_1');
    // 关键钉子：监听事件不进正常入站链路（不转发、不进收件箱、不回话）。
    expect(managerMessages).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    expect(manager.getInboxItems()).toHaveLength(0);
    expect(inboxChanges).toHaveLength(0);
  });

  it('normal message events still route through the full inbound path', async () => {
    fakeChannel.emit('message', fakeMessage('om_normal_1'));
    // handleMessage 是同步转发 + 异步 handler；给微任务一个回合。
    await new Promise((resolve) => setImmediate(resolve));
    expect(handler).toHaveBeenCalledWith(accountId, expect.objectContaining({ id: 'om_normal_1' }));
    expect(manager.getInboxItems().some((item) => item.message.id === 'om_normal_1')).toBe(true);
  });
});
