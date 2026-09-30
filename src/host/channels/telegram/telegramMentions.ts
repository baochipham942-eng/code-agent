// Telegram 群消息触达判定（N-TELEGRAM-INBOUND-FAILOPEN）：从 update 的 entities
// 与 reply_to_message 识别「@了 bot 或回复了 bot」，供准入门 checkInboundAccess 使用。
// entity offset/length 是 UTF-16 code unit 口径，与 JS 字符串切片一致。

interface TelegramMessageEntityLike {
  type: string;
  offset: number;
  length: number;
  user?: { id?: number };
}

export interface TelegramMentionProbe {
  text?: string;
  caption?: string;
  entities?: readonly TelegramMessageEntityLike[];
  caption_entities?: readonly TelegramMessageEntityLike[];
  reply_to_message?: { from?: { id?: number } };
}

export interface TelegramBotIdentity {
  id?: number;
  username?: string;
}

export function isTelegramBotMentioned(msg: TelegramMentionProbe, bot: TelegramBotIdentity): boolean {
  if (bot.id !== undefined && msg.reply_to_message?.from?.id === bot.id) return true;
  const username = bot.username?.toLowerCase();
  const probes: Array<[string, readonly TelegramMessageEntityLike[]]> = [
    [msg.text ?? '', msg.entities ?? []],
    [msg.caption ?? '', msg.caption_entities ?? []],
  ];
  for (const [text, entities] of probes) {
    for (const entity of entities) {
      if (entity.type === 'text_mention' && bot.id !== undefined && entity.user?.id === bot.id) {
        return true;
      }
      if (entity.type === 'mention' && username) {
        const mentioned = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
        if (mentioned === `@${username}`) return true;
      }
    }
  }
  return false;
}
