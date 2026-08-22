import { describe, expect, it } from 'vitest';
import { checkInboundAccess } from '../../../src/host/channels/inboundAccess';

describe('shared channel inbound access', () => {
  it('requires pairing for a Feishu direct message and allows it after pairing', () => {
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'p2p', mentionedBot: false, paired: false,
    })).toEqual({ action: 'pair', reason: 'p2p_unpaired' });
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'p2p', mentionedBot: false, paired: true,
    })).toEqual({ action: 'allow', auth: 'paired', reason: 'paired' });
  });

  it('drops group messages that do not mention the bot', () => {
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true,
    })).toEqual({ action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false });
  });

  it.each([
    ['disabled', true, 'deny'],
    ['allowlist', false, 'deny'],
    ['all_members', false, 'guest'],
  ] as const)('enforces Feishu group mode %s', (groupAccessMode, paired, action) => {
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: true, paired, groupAccessMode,
    }).action).toBe(action);
  });

  it('uses the same decision shape for Telegram user and chat allowlists', () => {
    expect(checkInboundAccess({
      channel: 'telegram', senderId: 7, chatId: 9, allowedUserIds: [7], allowedChatIds: [9],
    }).action).toBe('allow');
    expect(checkInboundAccess({
      channel: 'telegram', senderId: 8, chatId: 9, allowedUserIds: [7], allowedChatIds: [9],
    }).action).toBe('deny');
  });
});
