// isTelegramBotMentioned（N-TELEGRAM-INBOUND-FAILOPEN）：群消息触发门的判定 pin。
import { describe, expect, it } from 'vitest';
import { isTelegramBotMentioned } from '../../../src/host/channels/telegram/telegramMentions';

const BOT = { id: 100, username: 'NeoBot' };

describe('isTelegramBotMentioned', () => {
  it('detects an @username mention via entities', () => {
    expect(isTelegramBotMentioned({
      text: '@neobot 帮我看下这个',
      entities: [{ type: 'mention', offset: 0, length: 7 }],
    }, BOT)).toBe(true);
  });

  it('detects a text_mention (no username) by user id', () => {
    expect(isTelegramBotMentioned({
      text: 'Neo 在吗',
      entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: 100 } }],
    }, BOT)).toBe(true);
  });

  it('detects a reply to the bot by sender id', () => {
    expect(isTelegramBotMentioned({
      text: '接着说',
      reply_to_message: { from: { id: 100 } },
    }, BOT)).toBe(true);
  });

  it('checks caption entities for media messages', () => {
    expect(isTelegramBotMentioned({
      caption: '看这个 @NeoBot',
      caption_entities: [{ type: 'mention', offset: 4, length: 7 }],
    }, BOT)).toBe(true);
  });

  it('ignores mentions of a different user and replies to others', () => {
    expect(isTelegramBotMentioned({
      text: '@someoneelse 你看',
      entities: [{ type: 'mention', offset: 0, length: 12 }],
      reply_to_message: { from: { id: 200 } },
    }, BOT)).toBe(false);
  });

  it('ignores plain text that merely contains the bot name without an entity', () => {
    expect(isTelegramBotMentioned({ text: '@NeoBot 早' }, BOT)).toBe(false);
  });
});
