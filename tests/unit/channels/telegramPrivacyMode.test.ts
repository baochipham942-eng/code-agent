// Telegram connect reads getMe().can_read_all_group_messages onto the account and
// emits accounts_changed. Bot is stubbed; nothing leaves the process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelManager } from '../../../src/host/channels/channelManager';
import type { ChannelAccount } from '../../../src/shared/contract/channel';

const getMe = vi.hoisted(() => vi.fn());

vi.mock('grammy', () => ({
  Bot: class FakeTelegramBot {
    api = { getMe };
    on(): this { return this; }
    catch(): this { return this; }
    start(): void {}
    stop(): void {}
  },
}));

describe('Telegram privacy mode on connect', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    const manager = ChannelManager.getInstance();
    for (const accountId of createdIds.splice(0)) {
      await manager.disconnectAccount(accountId);
      await manager.deleteAccount(accountId);
    }
    getMe.mockReset();
  });

  it.each([
    { flag: false, label: 'false' },
    { flag: true, label: 'true' },
  ])('stores can_read_all_group_messages=$label and emits accounts_changed', async ({ flag }) => {
    getMe.mockResolvedValue({
      id: 7,
      is_bot: true,
      first_name: 'Neo',
      username: 'neo_bot',
      can_read_all_group_messages: flag,
    });
    const manager = ChannelManager.getInstance();
    const account = await manager.addAccount('privacy-hint', 'telegram', {
      type: 'telegram',
      botToken: '123:abc',
      groupAccessMode: 'all_members',
    });
    createdIds.push(account.id);

    const seen: Array<boolean | undefined> = [];
    const onChanged = (accounts: ChannelAccount[]) => {
      seen.push(accounts.find((item) => item.id === account.id)?.telegramCanReadAllGroupMessages);
    };
    manager.on('accounts_changed', onChanged);
    try {
      await manager.connectAccount(account.id);
    } finally {
      manager.off('accounts_changed', onChanged);
    }

    expect(manager.getAccount(account.id)?.telegramCanReadAllGroupMessages).toBe(flag);
    expect(seen).toContain(flag);
  });
});
