// ============================================================================
// Feishu listen message — 监听路径的 ChannelMessage 组装（N-TRIGGER-GROUP-LISTEN）
// ----------------------------------------------------------------------------
// 未 @ 的群消息命中显式监听绑定时，用与正常入站完全相同的组装管线
// （assembleFeishuInbound + sanitizeFeishuInboundMessage）构建 ChannelMessage，
// 但以 'listen_message' 事件发出：永不进 'message'，永不进收件箱/agent 桥。
// 不带 ingressAuth —— 监听事件既非 paired 也非 guest，下游只进 untrusted 事件块。
// ============================================================================

import type { ChannelMessage, ChannelPrivacyMode } from '../../../shared/contract/channel';
import {
  assembleFeishuInbound,
  extractFeishuPostText,
  type FeishuParentRead,
} from './feishuInboundContext';
import { sanitizeFeishuInboundMessage } from './feishuPrivacy';

export interface FeishuListenMessageInput {
  client: unknown;
  accountId: string;
  platform: 'feishu' | 'lark';
  privacyMode: ChannelPrivacyMode | null;
  parentRead?: FeishuParentRead;
  /** feishuChannel 内部 FeishuMessageEvent.message 的结构性子集（字段逐字同名）。 */
  msg: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: { id: { open_id: string } }[];
  };
  /** FeishuMessageEvent.sender 的结构性子集。 */
  sender: {
    sender_id: { open_id: string; user_id?: string };
    sender_type: string;
  };
  raw: unknown;
}

/** 与正常入站同构的监听消息组装；仅组装，不 emit（emit 由 feishuChannel 决定事件名）。 */
export async function buildFeishuListenChannelMessage(
  input: FeishuListenMessageInput,
): Promise<ChannelMessage> {
  const assembled = await assembleFeishuInbound({
    client: input.client,
    accountId: input.accountId,
    platform: input.platform,
    messageId: input.msg.message_id,
    messageType: input.msg.message_type,
    rawContent: input.msg.content,
    parentId: input.msg.parent_id,
    rootId: input.msg.root_id,
    threadId: input.msg.thread_id,
    parentRead: input.parentRead,
    renderPost: extractFeishuPostText,
  });

  return sanitizeFeishuInboundMessage({
    id: input.msg.message_id,
    channelId: input.accountId,
    sender: {
      id: input.sender.sender_id.open_id,
      name: input.sender.sender_id.user_id || input.sender.sender_id.open_id,
      isBot: input.sender.sender_type === 'bot',
    },
    context: {
      chatId: input.msg.chat_id,
      chatType: input.msg.chat_type,
      threadId: input.msg.root_id ?? input.msg.thread_id,
      replyToMessageId: input.msg.parent_id,
    },
    content: assembled.content,
    attachments: assembled.attachments,
    timestamp: parseInt(input.msg.create_time),
    mentions: input.msg.mentions?.map((mention) => mention.id.open_id),
    raw: input.raw,
  }, input.privacyMode);
}
