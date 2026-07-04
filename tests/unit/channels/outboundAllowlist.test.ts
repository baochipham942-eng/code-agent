// ============================================================================
// WP3-3 出站 send-target 白名单（fail-closed）契约：
// - 语义：未配置(undefined) = 功能关不破坏存量；配置空数组 = 全拒；
//   非法配置形态 / 空 target = 拒（护栏自身 fail-closed，绝不静默放行）
// - feishu / telegram 统一在 send 入口过校验：不在名单 → 结构化失败，绝不触达平台 API
// ============================================================================
import { describe, it, expect, vi } from 'vitest';
import { checkOutboundTarget } from '../../../src/host/channels/outboundAllowlist';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';
import { TelegramChannel } from '../../../src/host/channels/telegram/telegramChannel';

describe('checkOutboundTarget fail-closed 语义', () => {
  it('未配置（undefined/null）→ 功能关，允许（不破坏存量部署）', () => {
    expect(checkOutboundTarget(undefined, 'oc_x').allowed).toBe(true);
    expect(checkOutboundTarget(null, 'oc_x').allowed).toBe(true);
  });
  it('配置空数组 → 全拒（显式启用即 fail-closed）', () => {
    expect(checkOutboundTarget([], 'oc_x').allowed).toBe(false);
  });
  it('在名单 → 允许；不在名单 → 拒', () => {
    expect(checkOutboundTarget(['oc_a', 'oc_b'], 'oc_a').allowed).toBe(true);
    expect(checkOutboundTarget(['oc_a'], 'oc_evil').allowed).toBe(false);
  });
  it('非法配置形态（非数组）→ 拒（护栏自身 fail-closed）', () => {
    expect(checkOutboundTarget('oc_a' as never, 'oc_a').allowed).toBe(false);
    expect(checkOutboundTarget({ 0: 'oc_a' } as never, 'oc_a').allowed).toBe(false);
  });
  it('空 target → 拒', () => {
    expect(checkOutboundTarget(['oc_a'], '').allowed).toBe(false);
  });
  it('拒绝时带 reason（结构化失败，不静默 drop）', () => {
    const r = checkOutboundTarget(['oc_a'], 'oc_evil');
    expect(r.allowed).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(r.reason!.length).toBeGreaterThan(0);
  });
});

describe('feishu 出站白名单', () => {
  async function makeChannel(allowlist?: string[]) {
    const channel = new FeishuChannel('feishu-out');
    await channel.initialize({
      type: 'feishu',
      appId: 'cli_test',
      appSecret: 'secret_test',
      ...(allowlist ? { outboundAllowlist: allowlist } : {}),
    });
    const createMock = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
    (channel as unknown as { client: unknown }).client = { im: { message: { create: createMock } } };
    return { channel, createMock };
  }

  it('目标不在白名单 → 拒发（success:false + error），不触达平台 API', async () => {
    const { channel, createMock } = await makeChannel(['oc_allowed']);
    const r = await channel.sendMessage({ chatId: 'oc_evil', content: 'secret' });
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('目标在白名单 → 正常发送', async () => {
    const { channel, createMock } = await makeChannel(['oc_allowed']);
    const r = await channel.sendMessage({ chatId: 'oc_allowed', content: 'hi' });
    expect(r.success).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('sendCard 同样过白名单（对称应用）', async () => {
    const { channel, createMock } = await makeChannel(['oc_allowed']);
    const r = await channel.sendCard('oc_evil', 'card text');
    expect(r.success).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('未配置白名单 → 保持既有行为（放行）', async () => {
    const { channel, createMock } = await makeChannel();
    const r = await channel.sendMessage({ chatId: 'oc_any', content: 'hi' });
    expect(r.success).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('telegram 出站白名单（对称应用）', () => {
  async function makeChannel(allowlist?: string[]) {
    const channel = new TelegramChannel('tg-out');
    await channel.initialize({
      type: 'telegram',
      botToken: 'test-token',
      ...(allowlist ? { outboundAllowlist: allowlist } : {}),
    });
    const sendMock = vi.fn().mockResolvedValue({ message_id: 777 });
    (channel as unknown as { bot: unknown }).bot = { api: { sendMessage: sendMock } };
    return { channel, sendMock };
  }

  it('目标不在白名单 → 拒发，不触达平台 API', async () => {
    const { channel, sendMock } = await makeChannel(['123']);
    const r = await channel.sendMessage({ chatId: '456', content: 'secret' });
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('目标在白名单 → 正常发送', async () => {
    const { channel, sendMock } = await makeChannel(['123']);
    const r = await channel.sendMessage({ chatId: '123', content: 'hi' });
    expect(r.success).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('未配置白名单 → 保持既有行为（放行）', async () => {
    const { channel, sendMock } = await makeChannel();
    const r = await channel.sendMessage({ chatId: '999', content: 'hi' });
    expect(r.success).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
