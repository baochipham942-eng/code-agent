type FeishuGroupAccessMode = 'all_members' | 'allowlist' | 'disabled';

export type InboundAccessDecision =
  | { action: 'allow'; auth: 'paired'; reason: 'paired' | 'telegram_allowlist' }
  | { action: 'guest'; auth: 'guest'; reason: 'group_all_members_guest' | 'telegram_guest' }
  | { action: 'pair'; reason: 'p2p_unpaired' }
  | {
      action: 'deny';
      reason: 'group_not_mentioned' | 'group_disabled' | 'group_sender_unpaired' | 'telegram_allowlist';
      replyUnauthorized: boolean;
    };

type TelegramGroupAccessMode = 'all_members' | 'allowlist';

export type InboundAccessInput =
  | {
      channel: 'feishu';
      chatType: 'p2p' | 'group';
      mentionedBot: boolean;
      paired: boolean;
      groupAccessMode?: FeishuGroupAccessMode;
    }
  | {
      channel: 'telegram';
      chatType: 'p2p' | 'group';
      senderId: number;
      chatId?: number;
      /** 群消息是否触达 bot（@提及或回复 bot），由调用方从 update entities 判定 */
      mentionedBot?: boolean;
      allowedUserIds?: readonly number[];
      allowedChatIds?: readonly number[];
      /** 群准入档，默认 allowlist（群里也要 @ 才触发）；all_members = 全群无需 @ 以访客档触达 */
      groupAccessMode?: TelegramGroupAccessMode;
    };

/**
 * All channel ingress allow/deny decisions converge here. Callers own platform
 * parsing and side effects (reply, pairing request, audit), while the security
 * state machine stays deterministic and shared.
 */
export function checkInboundAccess(input: InboundAccessInput): InboundAccessDecision {
  if (input.channel === 'telegram') {
    const userIds = input.allowedUserIds ?? [];
    const chatIds = input.allowedChatIds ?? [];
    const userOk = userIds.length === 0 || userIds.includes(input.senderId);
    const chatOk = input.chatId === undefined || chatIds.length === 0 || chatIds.includes(input.chatId);
    // 显式名单语义不变：名单在册、身份越名即拒。
    if (!userOk || !chatOk) {
      return { action: 'deny', reason: 'telegram_allowlist', replyUnauthorized: false };
    }
    // 群消息触发门（与飞书同一准入模型）：默认要 @ 或回复 bot，all_members 显式放开。
    if (input.chatType === 'group' && input.groupAccessMode !== 'all_members' && !input.mentionedBot) {
      return { action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false };
    }
    if (userIds.length > 0 || chatIds.length > 0) {
      return { action: 'allow', auth: 'paired', reason: 'telegram_allowlist' };
    }
    // fail-open 修复：双名单皆空不再是「全员 paired」——陌生人一律访客档，
    // 工具表由下游 channelGuestToolPolicy 裁剪，需审批的工具天然够不到。
    return { action: 'guest', auth: 'guest', reason: 'telegram_guest' };
  }

  if (input.chatType === 'p2p') {
    return input.paired
      ? { action: 'allow', auth: 'paired', reason: 'paired' }
      : { action: 'pair', reason: 'p2p_unpaired' };
  }

  if (!input.mentionedBot) {
    return { action: 'deny', reason: 'group_not_mentioned', replyUnauthorized: false };
  }

  const mode = input.groupAccessMode ?? 'allowlist';
  if (mode === 'disabled') {
    return { action: 'deny', reason: 'group_disabled', replyUnauthorized: false };
  }
  if (input.paired) {
    return { action: 'allow', auth: 'paired', reason: 'paired' };
  }
  if (mode === 'all_members') {
    return { action: 'guest', auth: 'guest', reason: 'group_all_members_guest' };
  }
  return { action: 'deny', reason: 'group_sender_unpaired', replyUnauthorized: true };
}
