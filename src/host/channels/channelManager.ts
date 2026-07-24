
// ============================================================================
// Channel Manager - 通道管理器
// ============================================================================

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type {
  IChannelPlugin,
  ChannelPluginRegistration,
  ChannelMessageHandler,
  ChannelResponseCallback,
} from './channelInterface';
import type {
  ChannelType,
  ChannelAccount,
  ChannelAccountConfig,
  ChannelAccountStatus,
  ChannelInboxItem,
  ChannelMessage,
  ChannelOutboxDraft,
  SendMessageResult,
  RetryChannelMediaAttachmentRequest,
  RetryChannelMediaAttachmentResult,
} from '../../shared/contract/channel';
import { ApiChannel, createApiChannelFactory } from './api/apiChannel';
import { FeishuChannel, createFeishuChannelFactory, createLarkChannelFactory } from './feishu/feishuChannel';
import { TelegramChannel, createTelegramChannelFactory } from './telegram/telegramChannel';
import { getSecureStorage } from '../services/core/secureStorage';
import { createLogger } from '../services/infra/logger';
import { summarizeUserFacingError } from '../security/userFacingError';
import { summarizeChannelError } from './channelErrorSummary';

const logger = createLogger('ChannelManager');

// 存储键
const CHANNEL_ACCOUNTS_KEY = 'channel.accounts';

/**
 * 通道管理器事件
 */
export interface ChannelManagerEvents {
  /** 收到消息 */
  message: (accountId: string, message: ChannelMessage) => void;
  /** 账号状态变化 */
  account_status_change: (accountId: string, status: ChannelAccountStatus, error?: string) => void;
  /** 账号列表变化 */
  accounts_changed: (accounts: ChannelAccount[]) => void;
  /** 最近外部消息变化 */
  inbox_changed: (items: ChannelInboxItem[]) => void;
}

/**
 * 通道管理器
 *
 * 负责管理所有通道插件和账号
 */
export class ChannelManager extends EventEmitter {
  private static instance: ChannelManager | null = null;

  // 已注册的通道插件
  private pluginRegistry: Map<ChannelType, ChannelPluginRegistration> = new Map();
  // 活跃的通道实例
  private activeChannels: Map<string, IChannelPlugin> = new Map();
  // 账号配置 (内存缓存)
  private accounts: Map<string, ChannelAccount> = new Map();
  // 最近外部输入，仅保存在当前运行时内存中
  private inboxItems: Map<string, ChannelInboxItem> = new Map();
  // 消息处理器
  private messageHandler: ChannelMessageHandler | null = null;
  private readonly maxInboxItems = 100;

  private constructor() {
    super();
    this.registerBuiltinPlugins();
  }

  static getInstance(): ChannelManager {
    if (!ChannelManager.instance) {
      ChannelManager.instance = new ChannelManager();
    }
    return ChannelManager.instance;
  }

  // ========== 插件管理 ==========

  /**
   * 注册通道插件
   */
  registerPlugin(registration: ChannelPluginRegistration): void {
    this.pluginRegistry.set(registration.type, registration);
    logger.info('Registered channel plugin', { type: registration.type });
  }

  /**
   * 获取已注册的通道类型列表
   */
  getRegisteredChannelTypes(): ChannelType[] {
    return Array.from(this.pluginRegistry.keys());
  }

  /**
   * 获取通道元数据
   */
  getChannelMeta(type: ChannelType) {
    return this.pluginRegistry.get(type)?.meta;
  }

  // ========== 账号管理 ==========

  /**
   * 加载所有账号配置
   */
  async loadAccounts(): Promise<void> {
    try {
      const storage = getSecureStorage();
      const data = storage.get(CHANNEL_ACCOUNTS_KEY as never);
      if (data) {
        const accounts = JSON.parse(data) as ChannelAccount[];
        for (const account of accounts) {
          this.accounts.set(account.id, account);
        }
        logger.info(`Loaded ${accounts.length} channel accounts`);
      }
    } catch (error) {
      logger.error('Failed to load channel accounts', { error });
    }
  }

  /**
   * 保存账号配置
   */
  private saveAccounts(): void {
    try {
      const storage = getSecureStorage();
      const accounts = Array.from(this.accounts.values());
      storage.set(CHANNEL_ACCOUNTS_KEY as never, JSON.stringify(accounts));
    } catch (error) {
      logger.error('Failed to save channel accounts', { error });
    }
  }

  /**
   * 获取所有账号
   */
  getAccounts(): ChannelAccount[] {
    return Array.from(this.accounts.values());
  }

  /**
   * 获取指定账号
   */
  getAccount(accountId: string): ChannelAccount | undefined {
    return this.accounts.get(accountId);
  }

  /**
   * 添加账号
   */
  async addAccount(
    name: string,
    type: ChannelType,
    config: ChannelAccountConfig,
    defaultAgentId?: string
  ): Promise<ChannelAccount> {
    const registration = this.pluginRegistry.get(type);
    if (!registration) {
      throw new Error(`Unknown channel type: ${type}`);
    }

    const account: ChannelAccount = {
      id: uuidv4(),
      name,
      type,
      config,
      status: 'disconnected',
      enabled: true,
      createdAt: Date.now(),
      defaultAgentId,
    };

    this.accounts.set(account.id, account);
    this.saveAccounts();
    this.emit('accounts_changed', this.getAccounts());

    logger.info('Added channel account', { id: account.id, type, name });
    return account;
  }

  /**
   * 更新账号
   */
  async updateAccount(
    accountId: string,
    updates: {
      name?: string;
      config?: Partial<ChannelAccountConfig>;
      enabled?: boolean;
      defaultAgentId?: string;
    }
  ): Promise<ChannelAccount | null> {
    const account = this.accounts.get(accountId);
    if (!account) {
      return null;
    }

    // 如果正在连接，先断开
    if (this.activeChannels.has(accountId)) {
      await this.disconnectAccount(accountId);
    }

    // 更新账号
    if (updates.name !== undefined) {
      account.name = updates.name;
    }
    if (updates.config !== undefined) {
      account.config = { ...account.config, ...updates.config } as ChannelAccountConfig;
    }
    if (updates.enabled !== undefined) {
      account.enabled = updates.enabled;
    }
    if (updates.defaultAgentId !== undefined) {
      account.defaultAgentId = updates.defaultAgentId;
    }

    this.accounts.set(accountId, account);
    this.saveAccounts();
    this.emit('accounts_changed', this.getAccounts());

    logger.info('Updated channel account', { id: accountId });
    return account;
  }

  /**
   * 删除账号
   */
  async deleteAccount(accountId: string): Promise<boolean> {
    // 先断开连接
    await this.disconnectAccount(accountId);

    const deleted = this.accounts.delete(accountId);
    if (deleted) {
      this.saveAccounts();
      this.emit('accounts_changed', this.getAccounts());
      logger.info('Deleted channel account', { id: accountId });
    }
    return deleted;
  }

  // ========== 连接管理 ==========

  /**
   * 连接账号
   */
  async connectAccount(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    if (this.activeChannels.has(accountId)) {
      logger.warn('Account already connected', { accountId });
      return;
    }

    const registration = this.pluginRegistry.get(account.type);
    if (!registration) {
      throw new Error(`Unknown channel type: ${account.type}`);
    }

    // 创建通道实例
    const channel = registration.factory(accountId);

    // 监听事件
    channel.on('message', (message: ChannelMessage) => {
      this.handleMessage(accountId, message);
    });

    channel.on('status_change', (status: ChannelAccountStatus, error?: string) => {
      this.updateAccountStatus(accountId, status, error);
    });

    channel.on('error', (error: Error) => {
      const { summary } = summarizeUserFacingError(error, { surface: 'channel_reply' });
      logger.error('Channel error', { accountId, error: error.message });
      this.updateAccountStatus(accountId, 'error', summary);
    });

    // 卡片按钮回传（B3 审批回批）：透传给上层 relay，带上是哪个账号发来的。
    channel.on('card_action', (payload: { value?: string }) => {
      this.emit('card_action', accountId, payload);
    });

    try {
      // 初始化并连接
      await channel.initialize(account.config);
      await channel.connect();

      this.activeChannels.set(accountId, channel);
      this.updateAccountStatus(accountId, 'connected');
      account.lastConnectedAt = Date.now();
      this.saveAccounts();

      logger.info('Channel connected', { accountId, type: account.type });
    } catch (error) {
      const { summary } = summarizeUserFacingError(error, { surface: 'channel_reply' });
      this.updateAccountStatus(accountId, 'error', summary);
      throw error;
    }
  }

  /**
   * 断开账号连接
   */
  async disconnectAccount(accountId: string): Promise<void> {
    const channel = this.activeChannels.get(accountId);
    if (!channel) {
      return;
    }

    try {
      await channel.destroy();
    } catch (error) {
      logger.error('Error destroying channel', { accountId, error });
    }

    this.activeChannels.delete(accountId);
    this.updateAccountStatus(accountId, 'disconnected');
    logger.info('Channel disconnected', { accountId });
  }

  /**
   * 连接所有启用的账号
   */
  async connectAllEnabled(): Promise<void> {
    const enabledAccounts = Array.from(this.accounts.values()).filter(a => a.enabled);

    for (const account of enabledAccounts) {
      try {
        await this.connectAccount(account.id);
      } catch (error) {
        logger.error('Failed to connect account', { accountId: account.id, error });
      }
    }
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const accountIds = Array.from(this.activeChannels.keys());
    for (const accountId of accountIds) {
      await this.disconnectAccount(accountId);
    }
  }

  /**
   * 关闭通道管理器
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down channel manager...');
    await this.disconnectAll();
    logger.info('Channel manager shut down');
  }

  /**
   * 获取所有账号 (别名)
   */
  getAllAccounts(): ChannelAccount[] {
    return this.getAccounts();
  }

  getInboxItems(limit = 50, includeDismissed = false): ChannelInboxItem[] {
    return Array.from(this.inboxItems.values())
      .filter((item) => includeDismissed || item.status !== 'dismissed')
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit);
  }

  recordInboundMessage(accountId: string, message: ChannelMessage): ChannelInboxItem {
    const account = this.accounts.get(accountId);
    const id = this.getInboxItemId(accountId, message.id);
    const existing = this.inboxItems.get(id);
    const channelType = account?.type ?? 'http-api';
    const item: ChannelInboxItem = {
      id,
      accountId,
      accountName: account?.name || accountId,
      channelType,
      message,
      receivedAt: message.timestamp || Date.now(),
      status: existing?.status || 'new',
      sessionKey: existing?.sessionKey,
      sessionId: existing?.sessionId,
      error: existing?.error,
      outboxDraft: existing?.outboxDraft,
    };

    this.inboxItems.set(id, item);
    this.pruneInbox();
    this.emitInboxChanged();
    return item;
  }

  updateInboxItem(
    itemId: string,
    updates: Partial<Pick<ChannelInboxItem, 'status' | 'sessionKey' | 'sessionId' | 'error'>> & {
      outboxDraft?: ChannelOutboxDraft;
    },
  ): ChannelInboxItem | null {
    const existing = this.inboxItems.get(itemId);
    if (!existing) return null;

    const next: ChannelInboxItem = {
      ...existing,
      ...updates,
    };
    this.inboxItems.set(itemId, next);
    this.emitInboxChanged();
    return next;
  }

  dismissInboxItem(itemId: string): boolean {
    return Boolean(this.updateInboxItem(itemId, { status: 'dismissed' }));
  }

  getInboxItemId(accountId: string, messageId: string): string {
    return `${accountId}:${messageId}`;
  }

  /**
   * 获取所有已注册的插件
   */
  getRegisteredPlugins(): ChannelPluginRegistration[] {
    return Array.from(this.pluginRegistry.values());
  }

  // ========== 消息处理 ==========

  /**
   * 设置消息处理器
   */
  setMessageHandler(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * 获取已连接的通道实例（B3 relay 需要 FeishuChannel 专属的 sendCard/updateCard）。
   */
  getActiveChannel(accountId: string): IChannelPlugin | undefined {
    return this.activeChannels.get(accountId);
  }

  /**
   * 发送消息到指定账号
   */
  async sendMessage(
    accountId: string,
    chatId: string,
    content: string,
    options?: { replyToMessageId?: string; threadId?: string }
  ): Promise<SendMessageResult> {
    const channel = this.activeChannels.get(accountId);
    if (!channel) {
      return { success: false, error: 'Account not connected' };
    }

    return channel.sendMessage({
      chatId,
      content,
      ...options,
    });
  }

  /**
   * 获取响应回调
   */
  getResponseCallback(accountId: string, message: ChannelMessage): ChannelResponseCallback | null {
    const channel = this.activeChannels.get(accountId);
    if (!channel) {
      return null;
    }

    // 根据通道类型返回对应的回调
    if (channel instanceof ApiChannel) {
      return (channel as ApiChannel).getResponseCallback(message.id);
    } else if (channel instanceof FeishuChannel) {
      return (channel as FeishuChannel).getResponseCallback(
        message.context.chatId,
        message.id
      );
    } else if (channel instanceof TelegramChannel) {
      return (channel as TelegramChannel).getResponseCallback(
        message.context.chatId,
        message.id
      );
    }

    // 通用回调
    return {
      sendText: async (content: string) => {
        return channel.sendMessage({
          chatId: message.context.chatId,
          content,
          replyToMessageId: message.id,
        });
      },
    };
  }

  /**
   * 发送错误响应
   */
  async sendErrorResponse(
    accountId: string,
    message: ChannelMessage,
    errorMessage: string
  ): Promise<void> {
    const { summary, retryHint } = summarizeUserFacingError(errorMessage, { surface: 'channel_reply' });
    const channelSummary = summarizeChannelError(errorMessage).message;
    const channel = this.activeChannels.get(accountId);
    if (!channel) {
      throw new Error(`Account not connected: ${accountId}`);
    }

    if (channel instanceof ApiChannel) {
      (channel as ApiChannel).rejectRequest(message.id, new Error(summary));
      return;
    }

    await channel.sendMessage({
      chatId: message.context.chatId,
      content: `错误: ${summary || channelSummary}${retryHint ? `\n${retryHint}` : ''}`,
      replyToMessageId: message.id,
    });
  }

  async retryMediaAttachment(
    request: RetryChannelMediaAttachmentRequest,
  ): Promise<RetryChannelMediaAttachmentResult> {
    const account = this.accounts.get(request.accountId);
    if (!account) {
      return { success: false, error: 'Channel account not found' };
    }

    if (account.type !== 'feishu' && account.type !== 'lark') {
      return { success: false, error: 'Media retry is only supported for Feishu/Lark attachments' };
    }

    let channel = this.activeChannels.get(request.accountId);
    let transientChannel: IChannelPlugin | null = null;

    try {
      if (!channel) {
        const registration = this.pluginRegistry.get(account.type);
        if (!registration) {
          return { success: false, error: `Unknown channel type: ${account.type}` };
        }
        transientChannel = registration.factory(request.accountId);
        await transientChannel.initialize(account.config);
        channel = transientChannel;
      }

      if (!(channel instanceof FeishuChannel)) {
        return { success: false, error: 'Channel does not support media retry' };
      }

      const attachment = await channel.retryMediaAttachment(request.attachment);
      return {
        success: attachment.mediaState !== 'failed',
        attachment,
        error: attachment.mediaState === 'failed'
          ? typeof attachment.metadata?.retryError === 'string'
            ? attachment.metadata.retryError
            : 'Media retry failed'
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Channel media retry failed', {
        accountId: request.accountId,
        attachmentId: request.attachment.id,
        error: message,
      });
      return { success: false, error: message };
    } finally {
      await transientChannel?.destroy().catch(() => undefined);
    }
  }

  // ========== Private Methods ==========

  private registerBuiltinPlugins(): void {
    // 注册 HTTP API 通道
    this.registerPlugin({
      type: 'http-api',
      meta: {
        type: 'http-api',
        name: 'HTTP API',
        description: 'REST API 通道，支持同步和流式消息',
        capabilities: {
          streaming: true,
          editMessage: false,
          deleteMessage: false,
          addReaction: false,
          richText: true,
          attachments: true,
          images: true,
          mentions: false,
          threads: false,
          maxMessageLength: 100000,
        },
      },
      factory: createApiChannelFactory(),
    });

    // 注册飞书通道
    this.registerPlugin({
      type: 'feishu',
      meta: {
        type: 'feishu',
        name: '飞书',
        description: '飞书机器人通道，支持 P2P 和群聊',
        capabilities: {
          streaming: false,
          editMessage: true,
          deleteMessage: true,
          addReaction: true,
          richText: true,
          attachments: true,
          images: true,
          mentions: true,
          threads: true,
          maxMessageLength: 30000,
        },
      },
      factory: createFeishuChannelFactory(),
    });

    // 注册 Lark International 通道
    this.registerPlugin({
      type: 'lark',
      meta: {
        type: 'lark',
        name: 'Lark',
        description: 'Lark International Bot 通道，支持 P2P 和群聊',
        capabilities: {
          streaming: false,
          editMessage: true,
          deleteMessage: true,
          addReaction: true,
          richText: true,
          attachments: true,
          images: true,
          mentions: true,
          threads: true,
          maxMessageLength: 30000,
        },
      },
      factory: createLarkChannelFactory(),
    });

    // 注册 Telegram 通道
    this.registerPlugin({
      type: 'telegram',
      meta: {
        type: 'telegram',
        name: 'Telegram',
        description: 'Telegram Bot 通道，支持私聊和群组',
        capabilities: {
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
        },
      },
      factory: createTelegramChannelFactory(),
    });
  }

  private handleMessage(accountId: string, message: ChannelMessage): void {
    logger.debug('Received message', {
      accountId,
      messageId: message.id,
      sender: message.sender.name,
    });

    this.recordInboundMessage(accountId, message);

    // 发出事件
    this.emit('message', accountId, message);

    // 调用消息处理器
    if (this.messageHandler) {
      this.messageHandler(accountId, message).catch(error => {
        logger.error('Message handler error', { accountId, error });
      });
    }
  }

  private pruneInbox(): void {
    if (this.inboxItems.size <= this.maxInboxItems) return;
    const ordered = Array.from(this.inboxItems.values())
      .sort((a, b) => b.receivedAt - a.receivedAt);
    for (const item of ordered.slice(this.maxInboxItems)) {
      this.inboxItems.delete(item.id);
    }
  }

  private emitInboxChanged(): void {
    this.emit('inbox_changed', this.getInboxItems());
  }

  private updateAccountStatus(
    accountId: string,
    status: ChannelAccountStatus,
    error?: string
  ): void {
    const account = this.accounts.get(accountId);
    if (account) {
      account.status = status;
      account.errorMessage = error;
      this.accounts.set(accountId, account);
    }

    this.emit('account_status_change', accountId, status, error);
  }
}

// 单例获取
let channelManagerInstance: ChannelManager | null = null;

export function getChannelManager(): ChannelManager {
  if (!channelManagerInstance) {
    channelManagerInstance = ChannelManager.getInstance();
  }
  return channelManagerInstance;
}
