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
  ChannelMessage,
  ChannelEvent,
  SendMessageResult,
} from '../../shared/types/channel';
import { ApiChannel, createApiChannelFactory } from './api/apiChannel';
import { FeishuChannel, createFeishuChannelFactory } from './feishu/feishuChannel';
import { getSecureStorage } from '../services/core/secureStorage';
import { createLogger } from '../services/infra/logger';

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
  // 消息处理器
  private messageHandler: ChannelMessageHandler | null = null;

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
      logger.error('Channel error', { accountId, error: error.message });
      this.updateAccountStatus(accountId, 'error', error.message);
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.updateAccountStatus(accountId, 'error', message);
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
  }

  private handleMessage(accountId: string, message: ChannelMessage): void {
    logger.debug('Received message', {
      accountId,
      messageId: message.id,
      sender: message.sender.name,
    });

    // 发出事件
    this.emit('message', accountId, message);

    // 调用消息处理器
    if (this.messageHandler) {
      this.messageHandler(accountId, message).catch(error => {
        logger.error('Message handler error', { accountId, error });
      });
    }
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

/**
 * 初始化通道管理器
 * - 加载已保存的账号配置
 * - 自动连接所有启用的账号
 */
export async function initChannelManager(): Promise<ChannelManager> {
  const manager = getChannelManager();

  // 加载账号配置
  await manager.loadAccounts();

  // 自动连接所有启用的账号
  await manager.connectAllEnabled();

  return manager;
}
