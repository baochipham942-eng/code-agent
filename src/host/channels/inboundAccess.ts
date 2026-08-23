type FeishuGroupAccessMode = 'all_members' | 'allowlist' | 'disabled';

export type InboundAccessDecision =
  | { action: 'allow'; auth: 'paired'; reason: 'paired' | 'telegram_allowlist' }
  | { action: 'guest'; auth: 'guest'; reason: 'group_all_members_guest' }
  | { action: 'pair'; reason: 'p2p_unpaired' }
  | {
      action: 'deny';
      reason: 'group_not_mentioned' | 'group_disabled' | 'group_sender_unpaired' | 'telegram_allowlist';
      replyUnauthorized: boolean;
    };

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
      senderId: number;
      chatId?: number;
      allowedUserIds?: readonly number[];
      allowedChatIds?: readonly number[];
    };

/**
 * All channel ingress allow/deny decisions converge here. Callers own platform
 * parsing and side effects (reply, pairing request, audit), while the security
 * state machine stays deterministic and shared.
 */
export function checkInboundAccess(input: InboundAccessInput): InboundAccessDecision {
  if (input.channel === 'telegram') {
    const userAllowed = !input.allowedUserIds?.length || input.allowedUserIds.includes(input.senderId);
    const chatAllowed = input.chatId === undefined
      || !input.allowedChatIds?.length
      || input.allowedChatIds.includes(input.chatId);
    return userAllowed && chatAllowed
      ? { action: 'allow', auth: 'paired', reason: 'telegram_allowlist' }
      : { action: 'deny', reason: 'telegram_allowlist', replyUnauthorized: false };
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
