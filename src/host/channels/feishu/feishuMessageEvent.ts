// ============================================================================
// Feishu 通道模块级类型 + 纯 normalizer —— 从 feishuChannel.ts 抽出（无实例
// 状态），以保持该模块在 eslint max-lines 预算内。行为零变化，仅做机械搬移；
// FeishuChannel 及其消费方的导入路径（feishuChannel.ts）不变。
// ============================================================================

import type { ChannelCapabilities } from '../../../shared/contract/channel';
import type { FeishuMediaMessageType } from './feishuMedia';

export type FeishuPlatform = 'feishu' | 'lark';

/**
 * 飞书通道能力
 */
export const FEISHU_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  streaming: false, // 飞书不支持真正的流式，但支持消息编辑模拟
  editMessage: true,
  deleteMessage: true,
  addReaction: true,
  richText: true,
  attachments: true,
  images: true,
  mentions: true,
  threads: true,
  maxMessageLength: 30000,
};

/**
 * 飞书消息类型
 */
type FeishuMessageType = 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'interactive' | 'merge_forward';
type FeishuCardTextTag = 'lark_md' | 'plain_text';
type FeishuCardButtonType = 'primary';

interface FeishuCardText {
  content: string;
  tag: FeishuCardTextTag;
}

interface FeishuCardDivElement {
  tag: 'div';
  text: FeishuCardText;
}

interface FeishuCardButtonAction {
  tag: 'button';
  text: FeishuCardText;
  value: { action: string };
  type: FeishuCardButtonType;
}

interface FeishuCardActionElement {
  tag: 'action';
  actions: FeishuCardButtonAction[];
}

export type FeishuCardElement = FeishuCardDivElement | FeishuCardActionElement;

export interface FeishuCardContent {
  config: { wide_screen_mode: boolean };
  elements: FeishuCardElement[];
}

/**
 * 飞书事件回调接口
 */
interface FeishuMention {
  key: string;
  id: {
    open_id: string;
    user_id?: string;
  };
  name: string;
}

export interface FeishuMessageEvent {
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: FeishuMessageType;
    content: string;
    mentions?: FeishuMention[];
  };
  sender: {
    sender_id: {
      open_id: string;
      user_id?: string;
    };
    sender_type: string;
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readArrayField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function normalizeFeishuMessageType(value: unknown): FeishuMessageType | undefined {
  if (
    value === 'text' ||
    value === 'post' ||
    value === 'image' ||
    value === 'file' ||
    value === 'audio' ||
    value === 'media' ||
    value === 'interactive' ||
    value === 'merge_forward'
  ) {
    return value;
  }
  return undefined;
}

export function normalizeFeishuMediaMessageType(value: unknown): FeishuMediaMessageType | undefined {
  if (value === 'image' || value === 'file' || value === 'audio' || value === 'media') {
    return value;
  }
  return undefined;
}

function normalizeFeishuChatType(value: unknown): FeishuMessageEvent['message']['chat_type'] | undefined {
  if (value === 'p2p' || value === 'group') return value;
  return undefined;
}

function normalizeFeishuMention(value: unknown): FeishuMention | undefined {
  if (!isRecord(value)) return undefined;
  const id = readRecordField(value, 'id');
  if (!id) return undefined;
  const key = readStringField(value, 'key');
  const openId = readStringField(id, 'open_id');
  const name = readStringField(value, 'name');
  if (!key || !openId || !name) return undefined;
  return {
    key,
    id: {
      open_id: openId,
      user_id: readStringField(id, 'user_id'),
    },
    name,
  };
}

export function normalizeFeishuMessageEvent(payload: unknown): FeishuMessageEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const message = readRecordField(payload, 'message');
  const sender = readRecordField(payload, 'sender');
  if (!message || !sender) return undefined;

  const senderId = readRecordField(sender, 'sender_id');
  const openId = senderId ? readStringField(senderId, 'open_id') : undefined;
  const senderType = readStringField(sender, 'sender_type');
  const messageId = readStringField(message, 'message_id');
  const createTime = readStringField(message, 'create_time');
  const chatId = readStringField(message, 'chat_id');
  const chatType = normalizeFeishuChatType(message.chat_type);
  const messageType = normalizeFeishuMessageType(message.message_type);
  const content = readStringField(message, 'content');
  if (!openId || !senderType || !messageId || !createTime || !chatId || !chatType || !messageType || content === undefined) {
    return undefined;
  }

  const mentions = readArrayField(message, 'mentions')
    ?.map(normalizeFeishuMention)
    .filter((mention): mention is FeishuMention => Boolean(mention));

  return {
    message: {
      message_id: messageId,
      root_id: readStringField(message, 'root_id'),
      parent_id: readStringField(message, 'parent_id'),
      thread_id: readStringField(message, 'thread_id'),
      create_time: createTime,
      chat_id: chatId,
      chat_type: chatType,
      message_type: messageType,
      content,
      mentions,
    },
    sender: {
      sender_id: {
        open_id: openId,
        user_id: senderId ? readStringField(senderId, 'user_id') : undefined,
      },
      sender_type: senderType,
    },
  };
}
