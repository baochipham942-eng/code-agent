// ============================================================================
// Telegram Channel - Telegram Bot 通道实现 (Long Polling + 代理支持)
// ============================================================================

import { Bot, type Context } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  BaseChannelPlugin,
  type ChannelResponseCallback,
} from '../channelInterface';
import type {
  ChannelMeta,
  ChannelMessage,
  ChannelAccountConfig,
  TelegramChannelConfig,
  SendMessageOptions,
  SendMessageResult,
  ChannelCapabilities,
} from '../../../shared/types/channel';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TelegramChannel');

/**
 * Telegram 通道能力
 */
const TELEGRAM_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  editMessage: true,
  deleteMessage: true,
  addReaction: false,
  richText: true,
  attachments: true,
  images: true,
  mentions: false,
  threads: true,
  maxMessageLength: 4096,
};

/**
 * Telegram 通道实现
 */
export class TelegramChannel extends BaseChannelPlugin {
  readonly meta: ChannelMeta;
  private telegramConfig: TelegramChannelConfig | null = null;
  private bot: Bot | null = null;
  private isPolling = false;

  // 流式编辑节流
  private lastEditTime: Map<string, number> = new Map();
  // typing 状态定时器（每 4 秒续期，Telegram typing 状态 5 秒过期）
  private typingTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(accountId: string) {
    super(accountId);
    this.meta = {
      id: accountId,
      type: 'telegram',
      name: 'Telegram',
      description: 'Telegram Bot 通道，支持私聊和群组',
      capabilities: TELEGRAM_CHANNEL_CAPABILITIES,
    };
  }

  async initialize(config: ChannelAccountConfig): Promise<void> {
    if (config.type !== 'telegram') {
      throw new Error('Invalid config type for TelegramChannel');
    }
    this.telegramConfig = config as TelegramChannelConfig;
    this.config = config;

    // 解析代理配置
    const proxyUrl = this.telegramConfig.proxyUrl
      || process.env.HTTPS_PROXY
      || process.env.https_proxy;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientOptions: any = {};
    if (proxyUrl) {
      const agent = new HttpsProxyAgent(proxyUrl);
      // 提供自定义 fetch 确保代理在 Electron 环境中也能工作
      // node-fetch v2 支持 agent 选项，但 Electron 内置 fetch 不支持
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nf = require('node-fetch');
      const nodeFetch = (nf.default || nf) as Function;
      clientOptions.baseFetchConfig = { agent, compress: true };
      clientOptions.fetch = (url: any, init?: any) => nodeFetch(url, { ...init, agent });
      logger.info('Using proxy for Telegram', { proxyUrl });
    }

    // 创建 Bot 实例
    this.bot = new Bot(this.telegramConfig.botToken, {
      client: clientOptions,
    });

    logger.info('TelegramChannel initialized');
  }

  async connect(): Promise<void> {
    if (!this.bot || !this.telegramConfig) {
      throw new Error('TelegramChannel not initialized');
    }

    this.setStatus('connecting');

    try {
      // 先测试连接 (getMe)
      const me = await this.bot.api.getMe();
      logger.info('Telegram bot connected', {
        id: me.id,
        username: me.username,
        firstName: me.first_name,
      });

      // 注册消息处理器
      this.bot.on('message', (ctx) => {
        logger.info('Telegram raw message received', {
          messageId: ctx.message?.message_id,
          from: ctx.from?.username || ctx.from?.id,
          text: ctx.message?.text?.substring(0, 50),
          chatType: ctx.chat?.type,
        });
        if (ctx.message?.text) {
          this.handleTextMessage(ctx).catch(e =>
            logger.error('handleTextMessage error', { error: String(e) })
          );
        } else if (ctx.message?.photo) {
          this.handlePhotoMessage(ctx).catch(e =>
            logger.error('handlePhotoMessage error', { error: String(e) })
          );
        } else if (ctx.message?.document) {
          this.handleDocumentMessage(ctx).catch(e =>
            logger.error('handleDocumentMessage error', { error: String(e) })
          );
        }
      });

      // 错误处理
      this.bot.catch((err) => {
        logger.error('Telegram bot error', { error: String(err.error || err) });
      });

      // 启动 long polling
      this.isPolling = true;
      this.bot.start({
        onStart: () => {
          logger.info('Telegram long polling started');
          this.setStatus('connected');
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to connect TelegramChannel', { error: message });

      // 尝试备用代理
      if (this.telegramConfig.fallbackProxyUrl && !this.usedFallback) {
        logger.info('Trying fallback proxy...', { fallbackProxyUrl: this.telegramConfig.fallbackProxyUrl });
        this.usedFallback = true;
        await this.switchToFallbackProxy();
        return;
      }

      this.setStatus('error', message);
      throw error;
    }
  }

  private usedFallback = false;

  private async switchToFallbackProxy(): Promise<void> {
    if (!this.telegramConfig?.fallbackProxyUrl) return;

    const agent = new HttpsProxyAgent(this.telegramConfig.fallbackProxyUrl);
    const nf = require('node-fetch');
    const nodeFetch = (nf.default || nf) as Function;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot = new Bot(this.telegramConfig.botToken, {
      client: {
        baseFetchConfig: { agent, compress: true } as any,
        fetch: (url: any, init?: any) => nodeFetch(url, { ...init, agent }),
      },
    });

    await this.connect();
  }

  async disconnect(): Promise<void> {
    if (this.bot && this.isPolling) {
      this.bot.stop();
      this.isPolling = false;
    }
    this.setStatus('disconnected');
    logger.info('TelegramChannel disconnected');
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.bot = null;
    this.lastEditTime.clear();
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
  }

  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    if (!this.bot) {
      return { success: false, error: 'Channel not connected' };
    }

    try {
      const chatId = parseInt(options.chatId) || options.chatId;

      // 尝试发送 Markdown，失败则 fallback 纯文本
      let result;
      try {
        result = await this.bot.api.sendMessage(
          chatId,
          options.content,
          {
            parse_mode: this.telegramConfig?.parseMode,
            reply_parameters: options.replyToMessageId
              ? { message_id: parseInt(options.replyToMessageId) }
              : undefined,
          }
        );
      } catch (parseError) {
        // MarkdownV2 解析失败时回退纯文本
        logger.warn('Markdown parse failed, falling back to plain text', { error: String(parseError) });
        result = await this.bot.api.sendMessage(
          chatId,
          options.content,
          {
            reply_parameters: options.replyToMessageId
              ? { message_id: parseInt(options.replyToMessageId) }
              : undefined,
          }
        );
      }

      return {
        success: true,
        messageId: String(result.message_id),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to send Telegram message', { error: message });

      // 长消息自动分割
      if (message.includes('message is too long') && options.content.length > 4096) {
        return this.sendSplitMessage(options);
      }

      return { success: false, error: message };
    }
  }

  async editMessage(messageId: string, newContent: string): Promise<SendMessageResult> {
    if (!this.bot) {
      return { success: false, error: 'Channel not connected' };
    }

    // 从 messageId 中提取 chatId（格式: chatId:messageId）
    const [chatIdStr, msgIdStr] = messageId.includes(':')
      ? messageId.split(':')
      : [undefined, messageId];

    if (!chatIdStr) {
      return { success: false, error: 'chatId required for editMessage (use chatId:messageId format)' };
    }

    try {
      await this.bot.api.editMessageText(
        parseInt(chatIdStr),
        parseInt(msgIdStr),
        newContent
      );
      return { success: true, messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to edit Telegram message', { error: message });
      return { success: false, error: message };
    }
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    if (!this.bot) return false;

    const [chatIdStr, msgIdStr] = messageId.includes(':')
      ? messageId.split(':')
      : [undefined, messageId];

    if (!chatIdStr) return false;

    try {
      await this.bot.api.deleteMessage(parseInt(chatIdStr), parseInt(msgIdStr));
      return true;
    } catch (error) {
      logger.error('Failed to delete Telegram message', { error });
      return false;
    }
  }

  /**
   * 获取响应回调对象
   */
  getResponseCallback(chatId: string, replyToMessageId?: string): ChannelResponseCallback {
    const throttleMs = this.telegramConfig?.streamEditIntervalMs || 1000;

    // 开始 typing 状态（收到消息后立刻显示，每 4 秒续期）
    this.startTyping(chatId);

    return {
      sendText: async (content: string) => {
        // 停止 typing（即将发送真正的回复）
        this.stopTyping(chatId);
        // 长消息自动分割
        if (content.length > 4096) {
          return this.sendSplitMessage({ chatId, content, replyToMessageId });
        }
        return this.sendMessage({ chatId, content, replyToMessageId });
      },
      editMessage: async (messageId: string, content: string) => {
        // 节流：避免过于频繁的编辑
        const key = `${chatId}:${messageId}`;
        const now = Date.now();
        const lastEdit = this.lastEditTime.get(key) || 0;

        if (now - lastEdit < throttleMs) {
          return { success: true, messageId };
        }
        this.lastEditTime.set(key, now);

        // 编辑消息需要 chatId:messageId 格式
        const compositeId = messageId.includes(':') ? messageId : `${chatId}:${messageId}`;
        return this.editMessage(compositeId, content);
      },
    };
  }

  // ========== Private Methods ==========

  /**
   * 开始发送 typing 状态（每 4 秒续期）
   */
  private startTyping(chatId: string): void {
    this.stopTyping(chatId); // 清理旧的
    const chatIdNum = parseInt(chatId) || chatId;

    const sendTyping = () => {
      this.bot?.api.sendChatAction(chatIdNum, 'typing').catch(() => {
        // 静默忽略 typing 错误
      });
    };

    // 立刻发一次
    sendTyping();
    // 每 4 秒续期（Telegram typing 状态 5 秒过期）
    const timer = setInterval(sendTyping, 4000);
    this.typingTimers.set(chatId, timer);
  }

  /**
   * 停止 typing 状态
   */
  private stopTyping(chatId: string): void {
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
  }

  /**
   * 处理文本消息
   */
  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.message?.text || !ctx.from || ctx.from.is_bot) return;

    // 白名单检查
    if (!this.isAllowed(ctx.from.id, ctx.chat?.id)) {
      logger.info('Message from unauthorized user/chat', {
        userId: ctx.from.id,
        chatId: ctx.chat?.id,
      });
      return;
    }

    const channelMessage = this.buildChannelMessage(ctx, ctx.message.text);
    this.emit('message', channelMessage);
  }

  /**
   * 处理图片消息
   */
  private async handlePhotoMessage(ctx: Context): Promise<void> {
    if (!ctx.message?.photo || !ctx.from || ctx.from.is_bot) return;
    if (!this.isAllowed(ctx.from.id, ctx.chat?.id)) return;

    const caption = ctx.message.caption || '[图片]';
    const channelMessage = this.buildChannelMessage(ctx, caption, [{
      id: ctx.message.photo[ctx.message.photo.length - 1].file_id,
      type: 'image',
      name: 'photo.jpg',
      size: ctx.message.photo[ctx.message.photo.length - 1].file_size,
    }]);
    this.emit('message', channelMessage);
  }

  /**
   * 处理文档消息
   */
  private async handleDocumentMessage(ctx: Context): Promise<void> {
    if (!ctx.message?.document || !ctx.from || ctx.from.is_bot) return;
    if (!this.isAllowed(ctx.from.id, ctx.chat?.id)) return;

    const caption = ctx.message.caption || `[文件: ${ctx.message.document.file_name}]`;
    const channelMessage = this.buildChannelMessage(ctx, caption, [{
      id: ctx.message.document.file_id,
      type: 'file',
      name: ctx.message.document.file_name || 'file',
      mimeType: ctx.message.document.mime_type,
      size: ctx.message.document.file_size,
    }]);
    this.emit('message', channelMessage);
  }

  /**
   * 构建统一消息格式
   */
  private buildChannelMessage(
    ctx: Context,
    content: string,
    attachments?: Array<{ id: string; type: 'image' | 'file'; name: string; mimeType?: string; size?: number }>
  ): ChannelMessage {
    const msg = ctx.message!;
    const from = ctx.from!;
    const chat = ctx.chat!;

    return {
      id: String(msg.message_id),
      channelId: this._accountId,
      sender: {
        id: String(from.id),
        name: from.username || `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`,
        isBot: from.is_bot,
      },
      context: {
        chatId: String(chat.id),
        chatType: chat.type === 'private' ? 'p2p' : 'group',
        chatName: chat.type !== 'private' ? (chat as { title?: string }).title : undefined,
        replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      },
      content,
      attachments: attachments?.map(a => ({
        id: a.id,
        type: a.type,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      })),
      timestamp: msg.date * 1000, // Unix 秒 → 毫秒
      raw: msg,
    };
  }

  /**
   * 白名单检查
   */
  private isAllowed(userId: number, chatId?: number): boolean {
    if (!this.telegramConfig) return false;

    const { allowedUserIds, allowedChatIds } = this.telegramConfig;

    // 用户白名单检查
    if (allowedUserIds && allowedUserIds.length > 0) {
      if (!allowedUserIds.includes(userId)) return false;
    }

    // 群组白名单检查
    if (chatId && allowedChatIds && allowedChatIds.length > 0) {
      if (!allowedChatIds.includes(chatId)) return false;
    }

    return true;
  }

  /**
   * 长消息分割发送
   */
  private async sendSplitMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    const chunks = this.splitMessage(options.content, 4096);
    let lastMessageId: string | undefined;

    for (const chunk of chunks) {
      const result = await this.sendMessage({
        ...options,
        content: chunk,
        replyToMessageId: lastMessageId ? undefined : options.replyToMessageId,
      });
      if (!result.success) return result;
      lastMessageId = result.messageId;
    }

    return { success: true, messageId: lastMessageId };
  }

  /**
   * 在换行处分割长文本
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // 尝试在换行处分割
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength * 0.3) {
        // 没有合适的换行位置，在空格处分割
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength * 0.3) {
        // 强制分割
        splitIndex = maxLength;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }
}

/**
 * 创建 Telegram 通道工厂
 */
export function createTelegramChannelFactory() {
  return (accountId: string) => new TelegramChannel(accountId);
}
