// ============================================================================
// Feishu Channel - 飞书通道实现 (支持 WebSocket 长连接和 Webhook 模式)
// ============================================================================

import * as lark from '@larksuiteoapi/node-sdk';
import { v4 as uuidv4 } from 'uuid';
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'http';
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

  // Webhook 服务器
  private webhookApp: Express | null = null;
  private webhookServer: Server | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;

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
      if (this.feishuConfig.useWebSocket === true) {
        // 使用 WebSocket 长连接 (需要飞书后台配置)
        await this.connectWebSocket();
      } else {
        // 默认使用 Webhook 模式
        await this.startWebhookServer();
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
    // 关闭 WebSocket 连接
    if (this.wsClient) {
      this.wsClient = null;
    }

    // 关闭 Webhook 服务器
    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer!.close(() => resolve());
      });
      this.webhookServer = null;
      this.webhookApp = null;
      logger.info('Feishu webhook server stopped');
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
    logger.info('FeishuChannel.sendMessage called', {
      chatId: options.chatId,
      contentLength: options.content?.length || 0,
      contentPreview: options.content?.substring(0, 100),
    });

    if (!this.client) {
      logger.error('Channel not connected');
      return { success: false, error: 'Channel not connected' };
    }

    try {
      // 确定接收方类型
      const receiveIdType = this.getReceiveIdType(options.chatId);
      logger.info('Sending to Feishu API', { receiveIdType, chatId: options.chatId });

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

      logger.info('Feishu API response', { code: response.code, msg: response.msg, messageId: response.data?.message_id });

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

  /**
   * 启动 Webhook 服务器
   */
  private async startWebhookServer(): Promise<void> {
    if (!this.feishuConfig) {
      throw new Error('Config not initialized');
    }

    const port = this.feishuConfig.webhookPort || 3200;
    const host = this.feishuConfig.webhookHost || '0.0.0.0';

    // 创建事件分发器
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.feishuConfig.encryptKey,
      verificationToken: this.feishuConfig.verificationToken,
    }).register({
      'im.message.receive_v1': async (data) => {
        await this.handleMessageEvent(data as unknown as FeishuMessageEvent);
      },
    });

    // 创建 Express 应用
    this.webhookApp = express();
    this.webhookApp.use(express.json());
    this.webhookApp.use(express.urlencoded({ extended: true }));

    // Webhook 端点
    this.webhookApp.post('/webhook/feishu', async (req: Request, res: Response) => {
      try {
        const body = req.body;
        logger.debug('Received Feishu webhook', { type: body?.type, challenge: !!body?.challenge });

        // 处理 URL 验证请求
        if (body?.type === 'url_verification' || body?.challenge) {
          logger.info('Feishu URL verification', { challenge: body.challenge });
          res.json({ challenge: body.challenge });
          return;
        }

        // 处理事件 (schema 2.0 格式)
        if (body?.header?.event_type === 'im.message.receive_v1' && body?.event) {
          logger.info('Received Feishu message event', {
            eventId: body.header.event_id,
            messageId: body.event.message?.message_id,
            content: body.event.message?.content,
          });

          // 直接调用消息处理器
          const event: FeishuMessageEvent = {
            message: body.event.message,
            sender: body.event.sender,
          };
          logger.info('Calling handleMessageEvent...');
          await this.handleMessageEvent(event);
          logger.info('handleMessageEvent completed');
        } else {
          logger.warn('Unhandled webhook event', {
            type: body?.type,
            eventType: body?.header?.event_type,
            hasEvent: !!body?.event,
          });
        }

        res.json({ code: 0, msg: 'success' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Error handling Feishu webhook', { error: message });
        res.status(500).json({ code: -1, msg: message });
      }
    });

    // 健康检查端点
    this.webhookApp.get('/webhook/feishu', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        channel: 'feishu',
        appId: this.feishuConfig?.appId,
        timestamp: Date.now(),
      });
    });

    // 启动服务器
    return new Promise((resolve, reject) => {
      try {
        this.webhookServer = this.webhookApp!.listen(port, host, () => {
          logger.info('Feishu webhook server started', {
            host,
            port,
            endpoint: `http://${host}:${port}/webhook/feishu`,
          });
          logger.info('Configure this URL in Feishu developer console (use ngrok for public access):');
          logger.info(`  Local: http://localhost:${port}/webhook/feishu`);
          logger.info(`  Example with ngrok: ngrok http ${port}`);
          resolve();
        });

        this.webhookServer.on('error', (error) => {
          logger.error('Webhook server error', { error: String(error) });
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

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
    logger.info('handleMessageEvent called', {
      messageId: event.message?.message_id,
      messageType: event.message?.message_type,
      senderType: event.sender?.sender_type,
    });

    try {
      const msg = event.message;
      const sender = event.sender;

      // 忽略机器人自己发送的消息，避免无限循环
      if (sender.sender_type === 'bot') {
        logger.info('Ignoring bot message to prevent loop');
        return;
      }

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
      logger.info('Emitting message event', {
        messageId: channelMessage.id,
        content: channelMessage.content.substring(0, 50),
        chatId: channelMessage.context.chatId,
      });
      this.emit('message', channelMessage);
      logger.info('Message event emitted');
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
