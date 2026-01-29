// ============================================================================
// Feishu Channel - 飞书通道实现
// ============================================================================

import * as lark from '@larksuiteoapi/node-sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  BaseChannelPlugin,
  type ChannelResponseCallback,
} from '../channelInterface';
import type {
  ChannelMeta,
  ChannelMessage,
  ChannelAccountConfig,
  FeishuChannelConfig,
  SendMessageOptions,
  SendMessageResult,
  ChannelCapabilities,
  ChannelAttachment,
} from '../../../shared/types/channel';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FeishuChannel');

/**
 * 飞书通道能力
 */
const FEISHU_CHANNEL_CAPABILITIES: ChannelCapabilities = {
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
type FeishuMessageType = 'text' | 'post' | 'image' | 'interactive';

/**
 * 飞书事件回调接口
 */
interface FeishuMessageEvent {
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: FeishuMessageType;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id: string;
        user_id?: string;
      };
      name: string;
    }>;
  };
  sender: {
    sender_id: {
      open_id: string;
      user_id?: string;
    };
    sender_type: string;
  };
}

/**
 * 飞书通道实现
 */
export class FeishuChannel extends BaseChannelPlugin {
  readonly meta: ChannelMeta;
  private feishuConfig: FeishuChannelConfig | null = null;
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;

  // 消息 ID 映射 (用于编辑消息)
  private messageIdMap: Map<string, string> = new Map();

  constructor(accountId: string) {
    super(accountId);
    this.meta = {
      id: accountId,
      type: 'feishu',
      name: '飞书',
      description: '飞书机器人通道，支持 P2P 和群聊',
      capabilities: FEISHU_CHANNEL_CAPABILITIES,
    };
  }

  async initialize(config: ChannelAccountConfig): Promise<void> {
    if (config.type !== 'feishu') {
      throw new Error('Invalid config type for FeishuChannel');
    }
    this.feishuConfig = config as FeishuChannelConfig;
    this.config = config;

    // 初始化飞书客户端
    this.client = new lark.Client({
      appId: this.feishuConfig.appId,
      appSecret: this.feishuConfig.appSecret,
      disableTokenCache: false,
    });

    logger.info('FeishuChannel initialized', { appId: this.feishuConfig.appId });
  }

  async connect(): Promise<void> {
    if (!this.feishuConfig || !this.client) {
      throw new Error('FeishuChannel not initialized');
    }

    this.setStatus('connecting');

    try {
      if (this.feishuConfig.useWebSocket !== false) {
        // 使用 WebSocket 长连接 (推荐)
        await this.connectWebSocket();
      } else {
        // HTTP 回调模式 (需要公网 URL)
        logger.warn('HTTP callback mode requires external webhook configuration');
      }

      this.setStatus('connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to connect FeishuChannel', { error: message });
      this.setStatus('error', message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // WSClient 没有直接的 close 方法，设置为 null 即可
      this.wsClient = null;
    }
    this.setStatus('disconnected');
    logger.info('FeishuChannel disconnected');
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.client = null;
    this.messageIdMap.clear();
  }

  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    if (!this.client) {
      return { success: false, error: 'Channel not connected' };
    }

    try {
      // 确定接收方类型
      const receiveIdType = this.getReceiveIdType(options.chatId);

      // 构建消息内容
      const content = this.buildMessageContent(options.content);

      // 发送消息
      const response = await this.client.im.message.create({
        params: {
          receive_id_type: receiveIdType,
        },
        data: {
          receive_id: options.chatId,
          msg_type: 'text',
          content: JSON.stringify(content),
        },
      });

      if (response.code === 0 && response.data?.message_id) {
        const messageId = response.data.message_id;
        // 保存消息 ID 映射
        this.messageIdMap.set(options.chatId + '_last', messageId);
        return { success: true, messageId };
      }

      return { success: false, error: response.msg || 'Failed to send message' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to send Feishu message', { error: message });
      return { success: false, error: message };
    }
  }

  async editMessage(messageId: string, newContent: string): Promise<SendMessageResult> {
    if (!this.client) {
      return { success: false, error: 'Channel not connected' };
    }

    try {
      const content = this.buildMessageContent(newContent);

      const response = await this.client.im.message.patch({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify(content),
        },
      });

      if (response.code === 0) {
        return { success: true, messageId };
      }

      return { success: false, error: response.msg || 'Failed to edit message' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to edit Feishu message', { error: message });
      return { success: false, error: message };
    }
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const response = await this.client.im.message.delete({
        path: {
          message_id: messageId,
        },
      });

      return response.code === 0;
    } catch (error) {
      logger.error('Failed to delete Feishu message', { error });
      return false;
    }
  }

  async addReaction(messageId: string, reaction: string): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const response = await this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: reaction,
          },
        },
      });

      return response.code === 0;
    } catch (error) {
      logger.error('Failed to add Feishu reaction', { error });
      return false;
    }
  }

  /**
   * 获取响应回调对象
   */
  getResponseCallback(chatId: string, replyToMessageId?: string): ChannelResponseCallback {
    return {
      sendText: async (content: string) => {
        return this.sendMessage({
          chatId,
          content,
          replyToMessageId,
        });
      },
      editMessage: async (messageId: string, content: string) => {
        return this.editMessage(messageId, content);
      },
    };
  }

  // ========== Private Methods ==========

  private async connectWebSocket(): Promise<void> {
    if (!this.client || !this.feishuConfig) {
      throw new Error('Client not initialized');
    }

    // 创建 WebSocket 客户端
    this.wsClient = new lark.WSClient({
      appId: this.feishuConfig.appId,
      appSecret: this.feishuConfig.appSecret,
    });

    // 注册消息事件处理器
    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({
        encryptKey: this.feishuConfig.encryptKey,
        verificationToken: this.feishuConfig.verificationToken,
      }).register({
        'im.message.receive_v1': async (data) => {
          await this.handleMessageEvent(data as unknown as FeishuMessageEvent);
        },
      }),
    });

    logger.info('Feishu WebSocket connected');
  }

  private async handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
    try {
      const msg = event.message;
      const sender = event.sender;

      // 解析消息内容
      let content = '';
      let attachments: ChannelAttachment[] | undefined;

      if (msg.message_type === 'text') {
        const parsed = JSON.parse(msg.content);
        content = parsed.text || '';
      } else if (msg.message_type === 'post') {
        // 富文本消息，提取纯文本
        const parsed = JSON.parse(msg.content);
        content = this.extractTextFromPost(parsed);
      } else if (msg.message_type === 'image') {
        // 图片消息
        const parsed = JSON.parse(msg.content);
        content = '[图片]';
        attachments = [{
          id: parsed.image_key,
          type: 'image',
          name: 'image.png',
          url: parsed.image_key, // 需要通过 API 获取真实 URL
        }];
      }

      // 构建统一消息格式
      const channelMessage: ChannelMessage = {
        id: msg.message_id,
        channelId: this._accountId,
        sender: {
          id: sender.sender_id.open_id,
          name: sender.sender_id.user_id || sender.sender_id.open_id,
          isBot: sender.sender_type === 'bot',
        },
        context: {
          chatId: msg.chat_id,
          chatType: msg.chat_type,
          threadId: msg.root_id,
          replyToMessageId: msg.parent_id,
        },
        content,
        attachments,
        timestamp: parseInt(msg.create_time),
        mentions: msg.mentions?.map(m => m.id.open_id),
        raw: event,
      };

      // 发出消息事件
      this.emit('message', channelMessage);
    } catch (error) {
      logger.error('Error handling Feishu message event', { error });
      this.emit('error', error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  private extractTextFromPost(post: Record<string, unknown>): string {
    // 从富文本 post 中提取纯文本
    const content = (post.content as unknown[]) || [];
    const texts: string[] = [];

    for (const paragraph of content) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          const elem = element as Record<string, unknown>;
          if (elem.tag === 'text') {
            texts.push(elem.text as string);
          } else if (elem.tag === 'at') {
            texts.push(`@${elem.user_name || elem.user_id}`);
          }
        }
      }
    }

    return texts.join('');
  }

  private buildMessageContent(text: string): { text: string } {
    return { text };
  }

  private getReceiveIdType(chatId: string): 'open_id' | 'user_id' | 'chat_id' {
    // 根据 ID 格式判断类型
    if (chatId.startsWith('ou_')) {
      return 'open_id';
    } else if (chatId.startsWith('oc_')) {
      return 'chat_id';
    }
    return 'chat_id';
  }
}

/**
 * 创建飞书通道工厂
 */
export function createFeishuChannelFactory() {
  return (accountId: string) => new FeishuChannel(accountId);
}
