// channelListenRegistry — 监听绑定 resolver 槽的行为测试（N-TRIGGER-GROUP-LISTEN）。
// 关键性质：未注入 resolver 时恒 false（fail-closed，准入门继续拒未 @ 的群消息）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasChannelListenBinding,
  setChannelListenResolver,
} from '../../../src/host/channels/channelListenRegistry';

describe('channelListenRegistry', () => {
  afterEach(() => {
    setChannelListenResolver(undefined);
  });

  it('returns false when no resolver is registered (fail-closed)', () => {
    expect(hasChannelListenBinding('acc-1', 'chat-1')).toBe(false);
  });

  it('delegates to the registered resolver', () => {
    const resolver = vi.fn((accountId: string, chatId: string) => accountId === 'acc-1' && chatId === 'chat-1');
    setChannelListenResolver(resolver);
    expect(hasChannelListenBinding('acc-1', 'chat-1')).toBe(true);
    expect(hasChannelListenBinding('acc-1', 'chat-2')).toBe(false);
    expect(hasChannelListenBinding('acc-2', 'chat-1')).toBe(false);
    expect(resolver).toHaveBeenCalledWith('acc-1', 'chat-1');
  });

  it('unregistering restores the fail-closed default', () => {
    setChannelListenResolver(() => true);
    expect(hasChannelListenBinding('acc-1', 'chat-1')).toBe(true);
    setChannelListenResolver(undefined);
    expect(hasChannelListenBinding('acc-1', 'chat-1')).toBe(false);
  });
});
