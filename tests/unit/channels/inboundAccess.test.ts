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

  it('re-routes an un-mentioned group message to listen only with an explicit listen binding', () => {
    // 无绑定（缺省）：仍是 deny/group_not_mentioned —— ① 无绑定不放行。
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true, hasListenBinding: false,
    })).toEqual({ action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false });
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true,
    })).toEqual({ action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false });
    // 有绑定：改判 listen/group_listen（无 auth 档 —— 不进正常入站）。
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true, hasListenBinding: true,
    })).toEqual({ action: 'listen', reason: 'group_listen' });
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: false, hasListenBinding: true,
    })).toEqual({ action: 'listen', reason: 'group_listen' });
  });

  it('keeps denying un-mentioned messages in a disabled group even with a listen binding (fail-closed)', () => {
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true,
      groupAccessMode: 'disabled', hasListenBinding: true,
    })).toEqual({ action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false });
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true,
      groupAccessMode: 'allowlist', hasListenBinding: true,
    })).toEqual({ action: 'listen', reason: 'group_listen' });
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: false, paired: true,
      groupAccessMode: 'all_members', hasListenBinding: true,
    })).toEqual({ action: 'listen', reason: 'group_listen' });
  });

  it('ignores hasListenBinding outside the un-mentioned group branch (p2p and mentioned paths unchanged)', () => {
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'p2p', mentionedBot: false, paired: false, hasListenBinding: true,
    })).toEqual({ action: 'pair', reason: 'p2p_unpaired' });
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'p2p', mentionedBot: false, paired: true, hasListenBinding: true,
    })).toEqual({ action: 'allow', auth: 'paired', reason: 'paired' });
    // @ 了 bot 的群消息走原路径（allowlist + unpaired → group_sender_unpaired），与绑定无关。
    expect(checkInboundAccess({
      channel: 'feishu', chatType: 'group', mentionedBot: true, paired: false, hasListenBinding: true,
    })).toEqual({ action: 'deny', reason: 'group_sender_unpaired', replyUnauthorized: true });
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
      channel: 'telegram', chatType: 'p2p', senderId: 7, chatId: 9, allowedUserIds: [7], allowedChatIds: [9],
    }).action).toBe('allow');
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'p2p', senderId: 8, chatId: 9, allowedUserIds: [7], allowedChatIds: [9],
    }).action).toBe('deny');
  });

  it('treats unknown Telegram senders as guests when allowlists are empty (fail-open 修复)', () => {
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'p2p', senderId: 42,
    })).toEqual({ action: 'guest', auth: 'guest', reason: 'telegram_guest' });
  });

  it('drops Telegram group messages that neither mention nor reply to the bot', () => {
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'group', senderId: 42, chatId: 9, mentionedBot: false,
    })).toEqual({ action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false });
  });

  it('admits Telegram group messages mentioning the bot as guest for unknown senders', () => {
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'group', senderId: 42, chatId: 9, mentionedBot: true,
    })).toEqual({ action: 'guest', auth: 'guest', reason: 'telegram_guest' });
  });

  it('requires a mention even for allowlisted users in Telegram groups by default', () => {
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'group', senderId: 7, chatId: 9, mentionedBot: false, allowedUserIds: [7],
    })).toEqual({ action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false });
  });

  it('keeps explicitly allowlisted Telegram identities paired (unchanged semantics)', () => {
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'p2p', senderId: 7, allowedUserIds: [7],
    })).toEqual({ action: 'allow', auth: 'paired', reason: 'telegram_allowlist' });
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'group', senderId: 7, chatId: 9, mentionedBot: true, allowedUserIds: [7],
    }).action).toBe('allow');
  });

  it('lets any Telegram group member reach the bot as guest under explicit all_members mode', () => {
    expect(checkInboundAccess({
      channel: 'telegram', chatType: 'group', senderId: 42, chatId: 9, mentionedBot: false, groupAccessMode: 'all_members',
    })).toEqual({ action: 'guest', auth: 'guest', reason: 'telegram_guest' });
  });
});
