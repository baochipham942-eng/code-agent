// ============================================================================
// ChannelManager 出站掩码（N-OUTBOUND-SENSITIVE-GUARD 验收②）
// ----------------------------------------------------------------------------
// 通道回复的两个真实出口在离开本机前统一过 shape-only 掩码：
// ① getResponseCallback 返回的回调（Feishu 分支 + 通用兜底分支，Telegram/Api
//    与 Feishu 同一 instanceof 选路、同一包装器，不再重复）；
// ② ChannelManager.sendMessage（cron 推送等管理器侧直发）。
// 通道插件无感知：插件收到的是掩码后正文；掩码不留本地副本。
// 卡号为公开标准测试卡号；身份证号是 GB 11643 算法现造的校验位有效假号。
// ============================================================================
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccountConfig, ChannelMessage } from '../../../src/shared/contract/channel';
import { ChannelManager } from '../../../src/host/channels/channelManager';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';
import type { IChannelPlugin } from '../../../src/host/channels/channelInterface';

const TEST_CARD = '4111 1111 1111 1111';
const TEST_CHINA_ID = '110101199001011237';
const TEST_SK_KEY = `sk-proj-${'a'.repeat(50)}`;
const DIRTY_TEXT = `回复：卡 ${TEST_CARD}，证 ${TEST_CHINA_ID}，key ${TEST_SK_KEY}`;

function expectMasked(content: string): void {
  expect(content).not.toContain(TEST_CARD);
  expect(content).not.toContain(TEST_CHINA_ID);
  expect(content).not.toContain(TEST_SK_KEY);
  expect(content).toContain('[credit card hidden]');
  expect(content).toContain('[id number hidden]');
  expect(content).toContain('sk-p');
}

function fakeMessage(): ChannelMessage {
  return {
    id: 'om_dirty_1',
    channelId: 'acc-outbound',
    sender: { id: 'ou_sender', name: 'sender' },
    context: { chatId: 'oc_chat', chatType: 'group' },
    content: 'inbound',
    timestamp: 1_800_000_000_000,
  };
}

const FAKE_META = {
  type: 'feishu',
  name: 'Fake',
  description: 'fake',
  capabilities: {},
} as never;

/** 通用兜底分支用的假通道：不继承任何具体通道类 → getResponseCallback 走 else。 */
class FakeGenericChannel extends EventEmitter implements IChannelPlugin {
  readonly meta = FAKE_META;
  status = 'disconnected' as const;
  sendMessage = vi.fn(async () => ({ success: true, messageId: 'om_generic' }));
  constructor(readonly accountId: string) {
    super();
  }
  async initialize(_config: ChannelAccountConfig): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe('ChannelManager outbound sensitive guard', () => {
  let manager: ChannelManager;
  const accountIds: string[] = [];
  let labelCounter = 0;

  beforeEach(() => {
    manager = ChannelManager.getInstance();
  });

  afterEach(async () => {
    for (const id of accountIds.splice(0)) {
      await manager.disconnectAccount(id).catch(() => undefined);
      await manager.deleteAccount(id).catch(() => undefined);
    }
    vi.restoreAllMocks();
  });

  async function connectWithFactory(
    factory: (accountId: string) => IChannelPlugin,
  ): Promise<string> {
    manager.registerPlugin({ type: 'feishu', meta: FAKE_META, factory });
    labelCounter += 1;
    const account = await manager.addAccount(`outbound-${labelCounter}`, 'feishu', {
      type: 'feishu', appId: 'app', appSecret: 'secret',
    });
    accountIds.push(account.id);
    await manager.connectAccount(account.id);
    return account.id;
  }

  it('getResponseCallback Feishu branch masks sendText and editMessage content', async () => {
    const feishu = new FeishuChannel('acc-feishu-branch');
    vi.spyOn(feishu, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(feishu, 'connect').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(feishu, 'sendMessage')
      .mockResolvedValue({ success: true, messageId: 'om_masked' });
    vi.spyOn(feishu, 'editMessage')
      .mockResolvedValue({ success: true, messageId: 'om_edit' });
    const accountId = await connectWithFactory(() => feishu);

    const callback = manager.getResponseCallback(accountId, fakeMessage());
    expect(callback).not.toBeNull();

    const sent = await callback!.sendText(DIRTY_TEXT);
    expect(sent).toEqual({ success: true, messageId: 'om_masked' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expectMasked(sendSpy.mock.calls[0][0].content);
    // 会话目标与回复锚不被掩码波及。
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ chatId: 'oc_chat', replyToMessageId: 'om_dirty_1' });

    expect(callback!.editMessage).toBeDefined();
    await callback!.editMessage!('om_dirty_1', DIRTY_TEXT);
    expect(feishu.editMessage).toHaveBeenCalledWith('om_dirty_1', expect.any(String));
    expectMasked((feishu.editMessage as ReturnType<typeof vi.spyOn>).mock.calls[0][1]);
  });

  it('getResponseCallback generic fallback branch masks sendText content', async () => {
    const fake = new FakeGenericChannel('acc-generic');
    const accountId = await connectWithFactory(() => fake);

    const callback = manager.getResponseCallback(accountId, fakeMessage());
    expect(callback).not.toBeNull();
    expect(callback!.editMessage).toBeUndefined();

    await callback!.sendText(DIRTY_TEXT);
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    expectMasked(fake.sendMessage.mock.calls[0][0].content);
    expect(fake.sendMessage.mock.calls[0][0]).toMatchObject({
      chatId: 'oc_chat',
      replyToMessageId: 'om_dirty_1',
    });
  });

  it('ChannelManager.sendMessage masks content before handing it to the plugin', async () => {
    const feishu = new FeishuChannel('acc-sendmessage');
    vi.spyOn(feishu, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(feishu, 'connect').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(feishu, 'sendMessage')
      .mockResolvedValue({ success: true, messageId: 'om_push' });
    const accountId = await connectWithFactory(() => feishu);

    const result = await manager.sendMessage(accountId, 'oc_chat', DIRTY_TEXT, {
      replyToMessageId: 'om_dirty_1',
    });

    expect(result).toEqual({ success: true, messageId: 'om_push' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expectMasked(sendSpy.mock.calls[0][0].content);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      chatId: 'oc_chat',
      replyToMessageId: 'om_dirty_1',
    });
  });

  it('clean text reaches the plugin byte-identical', async () => {
    const fake = new FakeGenericChannel('acc-clean');
    const accountId = await connectWithFactory(() => fake);
    const clean = '今日简报：无异常，明细见 https://example.com/r?p=1。';
    await manager.sendMessage(accountId, 'oc_chat', clean);
    expect(fake.sendMessage.mock.calls[0][0].content).toBe(clean);
  });
});
