
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
  ChannelConversationListResponse,
} from '../../shared/contract/channel';
import { ApiChannel, createApiChannelFactory } from './api/apiChannel';
import { FeishuChannel, createFeishuChannelFactory, createLarkChannelFactory } from './feishu/feishuChannel';
import { TelegramChannel, createTelegramChannelFactory } from './telegram/telegramChannel';
import { getSecureStorage } from '../services/core/secureStorage';
import { createLogger } from '../services/infra/logger';
import { summarizeUserFacingError } from '../security/userFacingError';
import { summarizeChannelError } from './channelErrorSummary';
import {
  ChannelReconnectScheduler,
  channelConnectFailureText,
  channelReconnectingStatusText,
  isChannelConnectFailureRetryable,
} from './channelReconnectScheduler';
import { FEISHU_DEFAULT_HOST, LARK_DEFAULT_HOST } from '../../shared/constants';
import {
  getInboundPairingService,
  type InboundPairingRequest,
} from './inboundPairingService';

const logger = createLogger('ChannelManager');

// 存储键
const CHANNEL_ACCOUNTS_KEY = 'channel.accounts';

/**
 * 通道管理器事件
 */
export interface ChannelManagerEvents {
  /** 收到消息 */
  message: (accountId: string, message: ChannelMessage) => void;
  /** 收到监听事件（未 @ 但命中显式监听绑定的群消息）：只转发，不进收件箱、不触 messageHandler */
  listen_message: (accountId: string, message: ChannelMessage) => void;
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
  // 连接失败自动重试（N-FEISHU-WS-FIRST-RETRY）：按账号退避 + 唤醒/网络恢复立即重试
  private readonly connectRetries: ChannelReconnectScheduler;
  // 连接中的账号（connectAccount 从进入到 settle）：保证一账号至多一个活实例
  private readonly connectingAccounts = new Set<string>();
  // 手动断开意图：覆盖「连接进行中点断开」的竞态——status 会被随后的失败覆盖，
  // 只有这个标记能拦住 catch 里的自动重连。新的 connectAccount 意图会消费它。
  private readonly manualDisconnects = new Set<string>();

  private constructor() {
    super();
    this.registerBuiltinPlugins();
    this.connectRetries = new ChannelReconnectScheduler({
      onRetry: (accountId, attempt) => this.retryConnect(accountId, attempt),
      probeHostFor: (accountId) => this.reconnectProbeHost(accountId),
    });
    getInboundPairingService().configureAdapter({
      addPairedSender: (accountId, senderId) => this.addPairedSender(accountId, senderId),
      sendControlReply: async (accountId, chatId, replyToMessageId, content) => {
        const channel = this.activeChannels.get(accountId);
        if (!channel) throw new Error(`Channel account is not connected: ${accountId}`);
        const result = await channel.sendMessage({ chatId, replyToMessageId, content });
        if (!result.success) throw new Error(result.error || 'Failed to send channel control reply');
      },
    });
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

    // 手动更新视为重新编排：取消挂起的自动重连（disconnectAccount 只处理已活跃的）
    this.connectRetries.cancel(accountId);
    this.manualDisconnects.add(accountId);

    // 如果正在连接，先断开
    if (this.activeChannels.has(accountId)) {
      await this.disconnectAccount(accountId);
    } else if (account.status === 'connecting') {
      // 退避等待中的账号不在 activeChannels：重试已取消，把「重连中」收殓成
      // 已断开，否则下面的 saveAccounts 会把 connecting 状态写盘、界面停在重连中
      this.updateAccountStatus(accountId, 'disconnected');
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
    // 先断开连接（含取消自动重试）
    await this.disconnectAccount(accountId);

    const deleted = this.accounts.delete(accountId);
    if (deleted) {
      this.manualDisconnects.delete(accountId);
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

    if (this.connectingAccounts.has(accountId)) {
      logger.warn('Account connect already in flight', { accountId });
      return;
    }
    // 新的连接意图消费掉旧的手动断开标记
    this.manualDisconnects.delete(accountId);

    const registration = this.pluginRegistry.get(account.type);
    if (!registration) {
      throw new Error(`Unknown channel type: ${account.type}`);
    }

    // 创建通道实例
    const channel = registration.factory(accountId);
    const channelLabel = this.channelLabel(account);

    // 监听事件
    channel.on('message', (message: ChannelMessage) => {
      this.handleMessage(accountId, message);
    });

    // 监听事件（N-TRIGGER-GROUP-LISTEN）：未 @ 但命中显式监听绑定的群消息。
    // 只转发给事件订阅方（CronEventTrigger）：不进收件箱、不调 messageHandler，
    // agent 桥（经 setMessageHandler 注入）永远看不到它们。
    channel.on('listen_message', (message: ChannelMessage) => {
      this.emit('listen_message', accountId, message);
    });

    channel.on('status_change', (status: ChannelAccountStatus, error?: string) => {
      // 已建立的连接报 error（SDK onError 只在放弃后触发：reconnect exhausted /
      // pullConnectConfig 不可重试码）：连接已死且 SDK 不再自愈，死实例留在
      // activeChannels 只会让通道停在 error——交给 manager 销毁并按退避重连。
      if (status === 'error' && this.activeChannels.get(accountId) === channel) {
        this.takeOverDeadChannel(accountId, channel, error ?? '', channelLabel);
        return;
      }
      // 连接失败原因先翻成人话再落 errorMessage：设置页不出现 SDK 原文（raw 只进日志）。
      // 非失败状态带的消息（SDK onReconnecting 的「重连中」）本来就是人话，原样透传。
      this.updateAccountStatus(
        accountId,
        status,
        status === 'error' && error !== undefined ? channelConnectFailureText(error, channelLabel) : error,
      );
    });

    channel.on('error', (error: Error) => {
      // error 事件是消息处理失败，不是连接失败：不套「正在自动重试」模板、
      // 也不触发重连，只做脱敏压缩后落 errorMessage。
      const { summary } = summarizeUserFacingError(error, { surface: 'channel_reply' });
      logger.error('Channel error', { accountId, error: error.message });
      this.updateAccountStatus(accountId, 'error', summary);
    });

    // 卡片按钮回传（B3 审批回批）：透传给上层 relay，带上是哪个账号发来的。
    channel.on('card_action', (payload: {
      value?: string;
      operatorOpenId?: string;
      chatId?: string;
      verificationConfigured?: boolean;
    }) => {
      this.emit('card_action', accountId, payload);
    });

    channel.on('pairing_request', (request: InboundPairingRequest) => {
      void getInboundPairingService().request(request).catch((error: unknown) => {
        logger.error('Failed to create inbound pairing request', { accountId, error });
      });
    });

    this.connectingAccounts.add(accountId);
    try {
      // 初始化并连接
      await channel.initialize(account.config);
      await channel.connect();

      this.activeChannels.set(accountId, channel);
      this.updateAccountStatus(accountId, 'connected');
      account.lastConnectedAt = Date.now();
      this.saveAccounts();
      this.connectRetries.reset(accountId);

      logger.info('Channel connected', { accountId, type: account.type });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const humanMessage = channelConnectFailureText(raw, channelLabel);
      // 原始错误只进日志；errorMessage 落人话文案
      logger.warn('Channel connect failed', { accountId, type: account.type, error: raw });
      this.updateAccountStatus(accountId, 'error', humanMessage);
      // 失败实例显式销毁（无人持有的长连接/webhook 服务器不留孤儿），再决定是否自动重连
      await this.destroyFailedChannel(accountId, channel);
      if (isChannelConnectFailureRetryable(raw)) {
        this.scheduleConnectRetry(accountId, humanMessage);
      } else {
        // SDK 判定不可重试（凭据/配置类）：重放同一份凭据没有意义，不进无限退避。
        // destroy 会把状态打回 disconnected，这里重申 error 终态与人话原因。
        this.updateAccountStatus(accountId, 'error', humanMessage);
        logger.warn('Channel connect failure is not retryable, skipping auto-reconnect', { accountId });
      }
      throw error;
    } finally {
      this.connectingAccounts.delete(accountId);
    }
  }

  /**
   * 失败后的自动重连：启用中的账号进入退避等待，状态文案带重试序号与人话原因。
   * 手动断开过（disconnect/update 留下的标记）或已禁用的账号不再自动重连。
   */
  private scheduleConnectRetry(accountId: string, humanMessage: string): void {
    const account = this.accounts.get(accountId);
    if (!account?.enabled) return;
    // 手动断开过（disconnect/update）不自动重连；status 不能作判据——失败实例销毁时
    // 的 status_change 会把账号短暂写成 disconnected，属正常中间态。
    if (this.manualDisconnects.has(accountId)) return;
    const attempt = this.connectRetries.schedule(accountId);
    this.updateAccountStatus(
      accountId,
      'connecting',
      channelReconnectingStatusText(attempt, humanMessage),
    );
  }

  /** 调度器到点回调：守护条件不满足时跳过/取消，否则真连一次 */
  private retryConnect(accountId: string, attempt: number): void {
    const account = this.accounts.get(accountId);
    if (!account || !account.enabled || this.manualDisconnects.has(accountId)) {
      this.connectRetries.cancel(accountId);
      return;
    }
    if (this.activeChannels.has(accountId) || this.connectingAccounts.has(accountId)) return;
    logger.info('Retrying channel connect', { accountId, attempt });
    void this.connectAccount(accountId).catch(() => {
      // connectAccount 失败路径已写状态并排下一轮重试
    });
  }

  /**
   * 已建立连接的终态失败接管：与首连失败同一套收殓——移出活跃表、人话 error、
   * 销毁死实例、按可重试性决定是否排退避。凭据类失败不排重试，停在 error。
   */
  private takeOverDeadChannel(
    accountId: string,
    channel: IChannelPlugin,
    raw: string,
    channelLabel: string,
  ): void {
    const humanMessage = channelConnectFailureText(raw, channelLabel);
    logger.warn('Established channel failed, taking over reconnect', { accountId, error: raw });
    void (async () => {
      this.activeChannels.delete(accountId);
      this.updateAccountStatus(accountId, 'error', humanMessage);
      await this.destroyFailedChannel(accountId, channel);
      // 销毁期间用户可能已手动重连：那时不再排重试
      if (this.activeChannels.has(accountId) || this.connectingAccounts.has(accountId)) return;
      if (isChannelConnectFailureRetryable(raw)) {
        this.scheduleConnectRetry(accountId, humanMessage);
      } else {
        // destroy 会把状态打回 disconnected，重申 error 终态与人话原因
        this.updateAccountStatus(accountId, 'error', humanMessage);
        logger.warn('Channel failure is not retryable, skipping auto-reconnect', { accountId });
      }
    })();
  }

  private async destroyFailedChannel(accountId: string, channel: IChannelPlugin): Promise<void> {
    try {
      await channel.destroy();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to destroy channel after connect failure', { accountId, error: message });
    }
  }

  private channelLabel(account: ChannelAccount): string {
    return this.getChannelMeta(account.type)?.name ?? account.type;
  }

  /** 挂起重试期间的 DNS 探测目标：飞书/Lark 开放平台域名，其余通道不探测 */
  private reconnectProbeHost(accountId: string): string | undefined {
    const account = this.accounts.get(accountId);
    if (!account) return undefined;
    if (account.type === 'feishu') return FEISHU_DEFAULT_HOST;
    if (account.type === 'lark') return LARK_DEFAULT_HOST;
    return undefined;
  }

  /**
   * 断开账号连接
   */
  async disconnectAccount(accountId: string): Promise<void> {
    // 手动断开：取消挂起的自动重试（账号可能正在退避等待、不在 activeChannels），
    // 并记下断开意图，压住「连接进行中点断开」竞态里的失败重连。
    this.connectRetries.cancel(accountId);
    this.manualDisconnects.add(accountId);

    const channel = this.activeChannels.get(accountId);
    if (!channel) {
      // 没有活跃实例（从未连上 / 正在退避等待）：也要把状态从「重连中」收殓成已断开
      this.updateAccountStatus(accountId, 'disconnected');
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
    this.connectRetries.cancelAll();
    await this.disconnectAll();
    logger.info('Channel manager shut down');
  }

  /**
   * 获取所有账号 (别名)
   */
  getAllAccounts(): ChannelAccount[] {
    return this.getAccounts();
  }

  async listConversations(accountId: string): Promise<ChannelConversationListResponse> {
    const account = this.accounts.get(accountId);
    if (!account) {
      return { supported: false, conversations: [], error: 'Channel account not found' };
    }

    const activeChannel = this.activeChannels.get(accountId);
    if (activeChannel) {
      if (!activeChannel.listConversations) return { supported: false, conversations: [] };
      return { supported: true, conversations: await activeChannel.listConversations() };
    }

    const registration = this.pluginRegistry.get(account.type);
    if (!registration) {
      return { supported: false, conversations: [], error: `Unknown channel type: ${account.type}` };
    }
    const channel = registration.factory(accountId);
    if (!channel.listConversations) return { supported: false, conversations: [] };

    try {
      await channel.initialize(account.config);
      return { supported: true, conversations: await channel.listConversations() };
    } finally {
      try {
        await channel.destroy();
      } catch (error) {
        logger.warn('Failed to destroy temporary channel after listing conversations', { accountId, error });
      }
    }
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
        logger.error('Message handler error', {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
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

  private addPairedSender(accountId: string, senderId: string): boolean {
    const account = this.accounts.get(accountId);
    if (!account || (account.config.type !== 'feishu' && account.config.type !== 'lark')) {
      return false;
    }
    const allowlist = account.config.inboundAllowlist ?? [];
    if (!allowlist.includes(senderId)) {
      allowlist.push(senderId);
      account.config.inboundAllowlist = allowlist;
      this.accounts.set(accountId, account);
      this.saveAccounts();
      this.emit('accounts_changed', this.getAccounts());
    }
    return true;
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
