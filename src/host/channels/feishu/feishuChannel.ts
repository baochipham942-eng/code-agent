// ============================================================================
// Feishu Channel - 飞书通道实现 (支持 WebSocket 长连接和 Webhook 模式)
// ============================================================================

import * as lark from '@larksuiteoapi/node-sdk';
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  BaseChannelPlugin,
  type ChannelResponseCallback,
} from '../channelInterface';
import type {
  ChannelMeta,
  ChannelMessage,
  ChannelAccountConfig,
  ChannelPrivacyMode,
  FeishuChannelConfig,
  LarkChannelConfig,
  SendMessageOptions,
  SendMessageResult,
  ChannelCapabilities,
  ChannelAttachment,
} from '../../../shared/contract/channel';
import { createLogger } from '../../services/infra/logger';
import {
  sanitizeFeishuInboundMessage,
  resolveFeishuPrivacyMode,
} from './feishuPrivacy';
import {
  materializeFeishuMedia,
  type FeishuMediaMessageType,
} from './feishuMedia';

const logger = createLogger('FeishuChannel');
type FeishuPlatform = 'feishu' | 'lark';

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
type FeishuMessageType = 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'interactive';
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

type FeishuCardElement = FeishuCardDivElement | FeishuCardActionElement;

interface FeishuCardContent {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readArrayField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFeishuMessageType(value: unknown): FeishuMessageType | undefined {
  if (
    value === 'text' ||
    value === 'post' ||
    value === 'image' ||
    value === 'file' ||
    value === 'audio' ||
    value === 'media' ||
    value === 'interactive'
  ) {
    return value;
  }
  return undefined;
}

function normalizeFeishuMediaMessageType(value: unknown): FeishuMediaMessageType | undefined {
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

function normalizeFeishuMessageEvent(payload: unknown): FeishuMessageEvent | undefined {
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

/**
 * 飞书通道实现
 */
export class FeishuChannel extends BaseChannelPlugin {
  readonly meta: ChannelMeta;
  private readonly platform: FeishuPlatform;
  private feishuConfig: FeishuChannelConfig | LarkChannelConfig | null = null;
  private privacyMode: ChannelPrivacyMode = 'local-redact';
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;

  // Webhook 服务器
  private webhookApp: Express | null = null;
  private webhookServer: Server | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;

  // 消息 ID 映射 (用于编辑消息)
  private messageIdMap: Map<string, string> = new Map();

  // WebSocket 重连
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly maxReconnectAttempts = 10;

  constructor(accountId: string, platform: FeishuPlatform = 'feishu') {
    super(accountId);
    this.platform = platform;
    this.meta = {
      id: accountId,
      type: platform,
      name: platform === 'lark' ? 'Lark' : '飞书',
      description: platform === 'lark'
        ? 'Lark International Bot 通道，支持 P2P 和群聊'
        : '飞书机器人通道，支持 P2P 和群聊',
      capabilities: FEISHU_CHANNEL_CAPABILITIES,
    };
  }

  async initialize(config: ChannelAccountConfig): Promise<void> {
    if (config.type !== this.platform) {
      throw new Error(`Invalid config type for ${this.meta.name}Channel`);
    }
    this.feishuConfig = config as FeishuChannelConfig | LarkChannelConfig;
    this.privacyMode = resolveFeishuPrivacyMode(this.feishuConfig.privacyMode);
    this.config = config;

    const sdkDomain = this.getSdkDomain();

    // 初始化飞书/Lark 客户端
    this.client = new lark.Client({
      appId: this.feishuConfig.appId,
      appSecret: this.feishuConfig.appSecret,
      domain: sdkDomain,
      disableTokenCache: false,
    });

    logger.info(`${this.meta.name}Channel initialized`, {
      appId: this.feishuConfig.appId,
      platform: this.platform,
      sdkDomain: this.platform,
      privacyMode: this.privacyMode,
    });
  }

  async connect(): Promise<void> {
    if (!this.feishuConfig || !this.client) {
      throw new Error(`${this.meta.name}Channel not initialized`);
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
      logger.error(`Failed to connect ${this.meta.name}Channel`, { error: message });
      this.setStatus('error', message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

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
      logger.info(`${this.meta.name} webhook server stopped`);
    }

    this.setStatus('disconnected');
    logger.info(`${this.meta.name}Channel disconnected`);
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.client = null;
    this.messageIdMap.clear();
  }

  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    logger.info(`${this.meta.name}Channel.sendMessage called`, {
      chatId: options.chatId,
      contentLength: options.content?.length || 0,
    });

    if (!this.client) {
      logger.error('Channel not connected');
      return { success: false, error: 'Channel not connected' };
    }

    try {
      // 确定接收方类型
      const receiveIdType = this.getReceiveIdType(options.chatId);
      logger.info(`Sending to ${this.meta.name} API`, { receiveIdType, chatId: options.chatId });

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

      logger.info(`${this.meta.name} API response`, { code: response.code, msg: response.msg, messageId: response.data?.message_id });

      if (response.code === 0 && response.data?.message_id) {
        const messageId = response.data.message_id;
        // 保存消息 ID 映射
        this.messageIdMap.set(options.chatId + '_last', messageId);
        return { success: true, messageId };
      }

      return { success: false, error: response.msg || 'Failed to send message' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to send ${this.meta.name} message`, { error: message });
      return { success: false, error: message };
    }
  }

  async retryMediaAttachment(attachment: ChannelAttachment, cacheRoot?: string): Promise<ChannelAttachment> {
    if (!this.client) {
      throw new Error(`${this.meta.name}Channel not initialized`);
    }

    const metadata = isRecord(attachment.metadata) ? attachment.metadata : {};
    const messageId = readStringField(metadata, 'messageId');
    const resourceType =
      normalizeFeishuMediaMessageType(metadata.resourceType)
      ?? normalizeFeishuMediaMessageType(attachment.type)
      ?? 'file';
    const fileKey = attachment.platformFileKey || attachment.url || readStringField(metadata, 'platformFileKey');

    if (!messageId || !fileKey) {
      return {
        ...attachment,
        mediaState: 'failed',
        metadata: {
          ...metadata,
          materializationState: 'failed',
          retryError: 'missing-message-or-file-key',
        },
      };
    }

    const content = JSON.stringify({
      [resourceType === 'image'
        ? 'image_key'
        : resourceType === 'audio'
          ? 'file_key'
          : resourceType === 'media'
            ? 'media_key'
            : 'file_key']: fileKey,
      file_name: attachment.name,
      mime_type: attachment.mimeType,
      file_size: attachment.size,
    });

    const materialized = await materializeFeishuMedia({
      accountId: this._accountId,
      platform: this.platform,
      messageId,
      messageType: resourceType,
      content,
      client: this.client,
      cacheRoot,
    });

    return {
      ...attachment,
      ...(materialized?.attachments[0] ?? {}),
      metadata: {
        ...metadata,
        ...(materialized?.attachments[0]?.metadata ?? {}),
        retryAt: Date.now(),
      },
    };
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
      logger.error(`Failed to edit ${this.meta.name} message`, { error: message });
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
      logger.error(`Failed to delete ${this.meta.name} message`, { error });
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
      logger.error(`Failed to add ${this.meta.name} reaction`, { error });
      return false;
    }
  }

  /**
   * 获取响应回调对象
   */
  getResponseCallback(chatId: string, replyToMessageId?: string): ChannelResponseCallback {
    return {
      startTyping: async () => {
        if (!replyToMessageId) return;
        await this.addReaction(replyToMessageId, 'eyes');
      },
      stopTyping: async () => {},
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
      sendCard: async (text: string, buttons?: Array<{ text: string; value: string }>) => {
        return this.sendCard(chatId, text, buttons);
      },
    };
  }

  async sendCard(
    chatId: string,
    text: string,
    buttons?: Array<{ text: string; value: string }>
  ): Promise<SendMessageResult> {
    if (!this.client) {
      return { success: false, error: 'Channel not connected' };
    }

    try {
      const receiveIdType = this.getReceiveIdType(chatId);
      const card = this.buildCardContent(text, buttons);

      const response = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      if (response.code === 0 && response.data?.message_id) {
        return { success: true, messageId: response.data.message_id };
      }
      return { success: false, error: response.msg || 'Failed to send card' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to send ${this.meta.name} card`, { error: message });
      return { success: false, error: message };
    }
  }

  async sendStreamingMessage(
    chatId: string,
    stream: AsyncIterable<string>
  ): Promise<SendMessageResult> {
    // Send initial placeholder message
    const initial = await this.sendMessage({ chatId, content: '...' });
    if (!initial.success || !initial.messageId) {
      return initial;
    }

    let accumulated = '';
    let lastUpdateTime = 0;
    const throttleMs = 500;

    for await (const chunk of stream) {
      accumulated += chunk;
      const now = Date.now();

      if (now - lastUpdateTime >= throttleMs) {
        await this.editMessage(initial.messageId, accumulated);
        lastUpdateTime = now;
      }
    }

    // Final update with complete content
    if (accumulated) {
      await this.editMessage(initial.messageId, accumulated);
    }

    return { success: true, messageId: initial.messageId };
  }

  private buildCardContent(text: string, buttons?: Array<{ text: string; value: string }>): FeishuCardContent {
    const elements: FeishuCardElement[] = [
      {
        tag: 'div',
        text: { content: text, tag: 'lark_md' },
      },
    ];

    if (buttons && buttons.length > 0) {
      elements.push({
        tag: 'action',
        actions: buttons.map((b) => ({
          tag: 'button',
          text: { content: b.text, tag: 'plain_text' },
          value: { action: b.value },
          type: 'primary',
        })),
      });
    }

    return {
      config: { wide_screen_mode: true },
      elements,
    };
  }

  // ========== Private Methods ==========

  private getSdkDomain(): lark.Domain {
    return this.platform === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
  }

  private getWebhookPath(): string {
    return `/webhook/${this.platform}`;
  }

  /**
   * 启动 Webhook 服务器
   */
  private async startWebhookServer(): Promise<void> {
    if (!this.feishuConfig) {
      throw new Error('Config not initialized');
    }

    const port = this.feishuConfig.webhookPort ?? 3200;
    const host = this.feishuConfig.webhookHost ?? '0.0.0.0';

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
    const webhookPath = this.getWebhookPath();
    this.webhookApp.post(webhookPath, async (req: Request, res: Response) => {
      try {
        const body: unknown = req.body;
        const bodyRecord = isRecord(body) ? body : {};
        const bodyType = readStringField(bodyRecord, 'type');
        const challenge = readStringField(bodyRecord, 'challenge');
        const header = readRecordField(bodyRecord, 'header');
        const eventPayload = readRecordField(bodyRecord, 'event');
        const eventType = header ? readStringField(header, 'event_type') : undefined;
        logger.debug(`Received ${this.meta.name} webhook`, { type: bodyType, challenge: !!challenge });

        // 处理 URL 验证请求
        if (bodyType === 'url_verification' || challenge) {
          logger.info(`${this.meta.name} URL verification`, { challenge });
          res.json({ challenge });
          return;
        }

        // 处理事件 (schema 2.0 格式)
        if (eventType === 'im.message.receive_v1' && eventPayload) {
          const event = normalizeFeishuMessageEvent(eventPayload);
          logger.info(`Received ${this.meta.name} message event`, {
            eventId: header ? readStringField(header, 'event_id') : undefined,
            messageId: event?.message.message_id,
            contentLength: event?.message.content.length ?? 0,
          });

          if (event) {
            logger.info('Calling handleMessageEvent...');
            await this.handleMessageEvent(event);
            logger.info('handleMessageEvent completed');
          } else {
            logger.warn(`Malformed ${this.meta.name} message event payload`);
          }
        } else {
          logger.warn('Unhandled webhook event', {
            type: bodyType,
            eventType,
            hasEvent: !!eventPayload,
          });
        }

        res.json({ code: 0, msg: 'success' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Error handling ${this.meta.name} webhook`, { error: message });
        res.status(500).json({ code: -1, msg: message });
      }
    });

    // 健康检查端点
    this.webhookApp.get(webhookPath, (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        channel: this.platform,
        appId: this.feishuConfig?.appId,
        timestamp: Date.now(),
      });
    });

    // 启动服务器
    return new Promise((resolve, reject) => {
      try {
        this.webhookServer = this.webhookApp!.listen(port, host, () => {
          const address = this.webhookServer?.address();
          const actualPort = typeof address === 'object' && address
            ? (address as AddressInfo).port
            : port;
          const displayHost = host === '0.0.0.0' ? 'localhost' : host;
          logger.info(`${this.meta.name} webhook server started`, {
            host,
            port: actualPort,
            endpoint: `http://${displayHost}:${actualPort}${webhookPath}`,
          });
          logger.info(`Configure this URL in ${this.meta.name} developer console (use ngrok for public access):`);
          logger.info(`  Local: http://${displayHost}:${actualPort}${webhookPath}`);
          logger.info(`  Example with ngrok: ngrok http ${actualPort}`);
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
      domain: this.getSdkDomain(),
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

    logger.info(`${this.meta.name} WebSocket connected`);
    this.reconnectAttempts = 0; // Reset on successful connect
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached, giving up');
      this.setStatus('error', 'Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    logger.info('Scheduling WebSocket reconnect', {
      attempt: this.reconnectAttempts,
      delay,
    });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectWebSocket();
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        logger.info('WebSocket reconnected successfully');
      } catch (error) {
        logger.error('Reconnect failed', { error });
        this.scheduleReconnect();
      }
    }, delay);
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
        const parsed = parseJsonRecord(msg.content);
        content = readStringField(parsed, 'text') || '';
      } else if (msg.message_type === 'post') {
        // 富文本消息，提取纯文本
        const parsed = parseJsonRecord(msg.content);
        content = this.extractTextFromPost(parsed);
      } else if (
        msg.message_type === 'image' ||
        msg.message_type === 'file' ||
        msg.message_type === 'audio' ||
        msg.message_type === 'media'
      ) {
        const materialized = await materializeFeishuMedia({
          accountId: this._accountId,
          messageId: msg.message_id,
          messageType: msg.message_type as FeishuMediaMessageType,
          content: msg.content,
          client: this.client,
          platform: this.platform,
        });
        content = materialized?.content || `[${msg.message_type}]`;
        attachments = materialized?.attachments;
      }

      // 构建统一消息格式
      const channelMessage: ChannelMessage = sanitizeFeishuInboundMessage({
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
      }, this.privacyMode);

      // 发出消息事件
      logger.info('Emitting message event', {
        messageId: channelMessage.id,
        contentLength: channelMessage.content.length,
        chatId: channelMessage.context.chatId,
      });
      this.emit('message', channelMessage);
      logger.info('Message event emitted');
    } catch (error) {
      logger.error(`Error handling ${this.meta.name} message event`, { error });
      this.emit('error', error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  private extractTextFromPost(post: Record<string, unknown>): string {
    // 从富文本 post 中提取纯文本
    const content = readArrayField(post, 'content') || [];
    const texts: string[] = [];

    for (const paragraph of content) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (!isRecord(element)) continue;
          const tag = readStringField(element, 'tag');
          if (tag === 'text') {
            const text = readStringField(element, 'text');
            if (text) texts.push(text);
          } else if (tag === 'at') {
            const userName = readStringField(element, 'user_name');
            const userId = readStringField(element, 'user_id');
            texts.push(`@${userName || userId || ''}`);
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

/**
 * 创建 Lark International 通道工厂
 */
export function createLarkChannelFactory() {
  return (accountId: string) => new FeishuChannel(accountId, 'lark');
}
