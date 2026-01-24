// ============================================================================
// AgentBus - 多 Agent 通信总线
// 提供发布订阅机制 + 共享状态管理
// ============================================================================

import { EventEmitter } from 'events';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentBus');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 消息类型
 */
export type MessageType =
  | 'discovery'      // 发现（文件、模式、问题）
  | 'progress'       // 进度更新
  | 'request'        // 请求协助
  | 'response'       // 响应请求
  | 'broadcast'      // 广播消息
  | 'state_update'   // 状态更新
  | 'error'          // 错误报告
  | 'complete';      // 完成通知

/**
 * 消息优先级
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Agent 间消息
 */
export interface AgentMessage<T = unknown> {
  /** 消息 ID */
  id: string;
  /** 消息类型 */
  type: MessageType;
  /** 发送者 Agent ID */
  from: string;
  /** 接收者 Agent ID（null = 广播）*/
  to: string | null;
  /** 消息主题/频道 */
  channel: string;
  /** 消息内容 */
  payload: T;
  /** 优先级 */
  priority: MessagePriority;
  /** 时间戳 */
  timestamp: number;
  /** 关联的消息 ID（用于请求-响应） */
  correlationId?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 消息订阅者
 */
export interface MessageSubscriber<T = unknown> {
  /** 订阅 ID */
  id: string;
  /** 订阅的 Agent ID */
  agentId: string;
  /** 订阅的频道 */
  channel: string;
  /** 处理函数 */
  handler: (message: AgentMessage<T>) => void | Promise<void>;
  /** 过滤函数 */
  filter?: (message: AgentMessage<T>) => boolean;
}

/**
 * 共享状态条目
 */
export interface SharedStateEntry<T = unknown> {
  /** 键名 */
  key: string;
  /** 值 */
  value: T;
  /** 所有者 Agent ID */
  owner: string;
  /** 版本号 */
  version: number;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 过期时间（0 = 永不过期） */
  expiresAt: number;
  /** 是否只读（其他 Agent 不能修改） */
  readonly: boolean;
}

/**
 * 状态变更事件
 */
export interface StateChangeEvent<T = unknown> {
  key: string;
  oldValue: T | undefined;
  newValue: T;
  changedBy: string;
  version: number;
}

/**
 * 请求-响应选项
 */
export interface RequestOptions {
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 是否需要所有订阅者响应 */
  waitForAll?: boolean;
}

/**
 * AgentBus 配置
 */
export interface AgentBusConfig {
  /** 消息队列最大长度 */
  maxQueueSize: number;
  /** 消息保留时间（毫秒） */
  messageRetention: number;
  /** 状态过期检查间隔（毫秒） */
  stateCleanupInterval: number;
  /** 默认请求超时（毫秒） */
  defaultRequestTimeout: number;
  /** 是否启用消息历史 */
  enableHistory: boolean;
}

const DEFAULT_CONFIG: AgentBusConfig = {
  maxQueueSize: 1000,
  messageRetention: 300000, // 5 分钟
  stateCleanupInterval: 30000, // 30 秒
  defaultRequestTimeout: 30000, // 30 秒
  enableHistory: true,
};

// ----------------------------------------------------------------------------
// AgentBus
// ----------------------------------------------------------------------------

/**
 * Agent 通信总线
 *
 * 核心功能：
 * 1. 发布/订阅消息系统
 * 2. 共享状态管理
 * 3. 请求-响应模式
 * 4. 消息队列和历史
 */
export class AgentBus extends EventEmitter {
  private config: AgentBusConfig;
  private subscribers: Map<string, MessageSubscriber[]> = new Map();
  private sharedState: Map<string, SharedStateEntry> = new Map();
  private messageHistory: AgentMessage[] = [];
  private pendingRequests: Map<string, {
    resolve: (response: AgentMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    responses: AgentMessage[];
    waitForAll: boolean;
    expectedCount: number;
  }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private messageIdCounter = 0;

  constructor(config: Partial<AgentBusConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTask();
    logger.info('AgentBus initialized');
  }

  // ==========================================================================
  // Publish/Subscribe
  // ==========================================================================

  /**
   * 订阅频道消息
   */
  subscribe<T = unknown>(
    agentId: string,
    channel: string,
    handler: (message: AgentMessage<T>) => void | Promise<void>,
    filter?: (message: AgentMessage<T>) => boolean
  ): string {
    const subscriberId = this.generateId('sub');
    const subscriber: MessageSubscriber<T> = {
      id: subscriberId,
      agentId,
      channel,
      handler: handler as (message: AgentMessage) => void | Promise<void>,
      filter: filter as ((message: AgentMessage) => boolean) | undefined,
    };

    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)!.push(subscriber as MessageSubscriber);

    logger.debug(`Agent ${agentId} subscribed to channel: ${channel}`);
    return subscriberId;
  }

  /**
   * 取消订阅
   */
  unsubscribe(subscriberId: string): boolean {
    for (const [channel, subs] of this.subscribers) {
      const index = subs.findIndex(s => s.id === subscriberId);
      if (index !== -1) {
        subs.splice(index, 1);
        logger.debug(`Unsubscribed: ${subscriberId} from ${channel}`);
        return true;
      }
    }
    return false;
  }

  /**
   * 取消某个 Agent 的所有订阅
   */
  unsubscribeAll(agentId: string): number {
    let count = 0;
    for (const [, subs] of this.subscribers) {
      for (let i = subs.length - 1; i >= 0; i--) {
        if (subs[i].agentId === agentId) {
          subs.splice(i, 1);
          count++;
        }
      }
    }
    logger.debug(`Unsubscribed ${count} subscriptions for agent: ${agentId}`);
    return count;
  }

  /**
   * 发布消息到频道
   */
  async publish<T = unknown>(
    from: string,
    channel: string,
    payload: T,
    options: {
      type?: MessageType;
      to?: string | null;
      priority?: MessagePriority;
      correlationId?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<AgentMessage<T>> {
    const message: AgentMessage<T> = {
      id: this.generateId('msg'),
      type: options.type || 'broadcast',
      from,
      to: options.to ?? null,
      channel,
      payload,
      priority: options.priority || 'normal',
      timestamp: Date.now(),
      correlationId: options.correlationId,
      metadata: options.metadata,
    };

    // 保存到历史
    if (this.config.enableHistory) {
      this.addToHistory(message as AgentMessage);
    }

    // 获取频道订阅者
    const subscribers = this.subscribers.get(channel) || [];

    // 按优先级排序
    const sortedSubs = this.sortByPriority(subscribers, message.priority);

    // 分发消息
    await this.dispatchMessage(message as AgentMessage, sortedSubs);

    // 发送总线事件
    this.emit('message', message);
    this.emit(`message:${channel}`, message);

    return message;
  }

  /**
   * 发送请求并等待响应
   */
  async request<TReq, TRes = unknown>(
    from: string,
    channel: string,
    payload: TReq,
    options: RequestOptions = {}
  ): Promise<AgentMessage<TRes>> {
    const timeout = options.timeout || this.config.defaultRequestTimeout;
    const correlationId = this.generateId('req');

    // 创建请求消息
    const message = await this.publish(from, channel, payload, {
      type: 'request',
      correlationId,
    });

    // 等待响应
    return new Promise<AgentMessage<TRes>>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request timeout: ${correlationId}`));
      }, timeout);

      const subscribers = this.subscribers.get(channel) || [];

      this.pendingRequests.set(correlationId, {
        resolve: resolve as (response: AgentMessage) => void,
        reject,
        timeout: timeoutHandle,
        responses: [],
        waitForAll: options.waitForAll || false,
        expectedCount: subscribers.filter(s => s.agentId !== from).length,
      });
    });
  }

  /**
   * 响应请求
   */
  async respond<T>(
    from: string,
    originalMessage: AgentMessage,
    payload: T
  ): Promise<void> {
    if (!originalMessage.correlationId) {
      logger.warn('Cannot respond to message without correlationId');
      return;
    }

    const response = await this.publish(from, originalMessage.channel, payload, {
      type: 'response',
      to: originalMessage.from,
      correlationId: originalMessage.correlationId,
    });

    // 检查是否有等待的请求
    const pending = this.pendingRequests.get(originalMessage.correlationId);
    if (pending) {
      pending.responses.push(response as AgentMessage);

      if (pending.waitForAll) {
        // 等待所有响应
        if (pending.responses.length >= pending.expectedCount) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(originalMessage.correlationId);
          // 返回最后一个响应（或可以聚合）
          pending.resolve(response as AgentMessage);
        }
      } else {
        // 第一个响应即返回
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(originalMessage.correlationId);
        pending.resolve(response as AgentMessage);
      }
    }
  }

  // ==========================================================================
  // Shared State
  // ==========================================================================

  /**
   * 设置共享状态
   */
  setState<T>(
    key: string,
    value: T,
    owner: string,
    options: {
      readonly?: boolean;
      ttl?: number;
    } = {}
  ): void {
    const existing = this.sharedState.get(key);
    const now = Date.now();

    // 检查是否可以修改
    if (existing && existing.readonly && existing.owner !== owner) {
      throw new Error(`Cannot modify readonly state: ${key} (owned by ${existing.owner})`);
    }

    const entry: SharedStateEntry<T> = {
      key,
      value,
      owner,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      expiresAt: options.ttl ? now + options.ttl : 0,
      readonly: options.readonly || false,
    };

    this.sharedState.set(key, entry as SharedStateEntry);

    // 发送状态变更事件
    const changeEvent: StateChangeEvent<T> = {
      key,
      oldValue: existing?.value as T | undefined,
      newValue: value,
      changedBy: owner,
      version: entry.version,
    };

    this.emit('state:change', changeEvent);
    this.emit(`state:change:${key}`, changeEvent);

    logger.debug(`State updated: ${key} by ${owner} (v${entry.version})`);
  }

  /**
   * 获取共享状态
   */
  getState<T>(key: string): T | undefined {
    const entry = this.sharedState.get(key);
    if (!entry) return undefined;

    // 检查过期
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.sharedState.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * 获取状态详情
   */
  getStateEntry<T>(key: string): SharedStateEntry<T> | undefined {
    const entry = this.sharedState.get(key);
    if (!entry) return undefined;

    // 检查过期
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.sharedState.delete(key);
      return undefined;
    }

    return entry as SharedStateEntry<T>;
  }

  /**
   * 删除共享状态
   */
  deleteState(key: string, requester: string): boolean {
    const entry = this.sharedState.get(key);
    if (!entry) return false;

    // 检查权限
    if (entry.readonly && entry.owner !== requester) {
      throw new Error(`Cannot delete readonly state: ${key} (owned by ${entry.owner})`);
    }

    this.sharedState.delete(key);
    this.emit('state:delete', { key, deletedBy: requester });
    logger.debug(`State deleted: ${key} by ${requester}`);
    return true;
  }

  /**
   * 获取某个 Agent 拥有的所有状态
   */
  getAgentStates(agentId: string): SharedStateEntry[] {
    const states: SharedStateEntry[] = [];
    for (const entry of this.sharedState.values()) {
      if (entry.owner === agentId) {
        states.push(entry);
      }
    }
    return states;
  }

  /**
   * 批量获取状态
   */
  getStates(pattern?: RegExp): Map<string, SharedStateEntry> {
    const result = new Map<string, SharedStateEntry>();
    for (const [key, entry] of this.sharedState) {
      if (!pattern || pattern.test(key)) {
        // 检查过期
        if (entry.expiresAt === 0 || Date.now() <= entry.expiresAt) {
          result.set(key, entry);
        }
      }
    }
    return result;
  }

  /**
   * 监听状态变更
   */
  watchState<T>(
    key: string,
    callback: (event: StateChangeEvent<T>) => void
  ): () => void {
    const handler = (event: StateChangeEvent<T>) => callback(event);
    this.on(`state:change:${key}`, handler);
    return () => this.off(`state:change:${key}`, handler);
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * 广播发现
   */
  async broadcastDiscovery(
    from: string,
    discovery: {
      type: 'file' | 'pattern' | 'issue' | 'insight';
      content: string;
      confidence?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.publish(from, 'discoveries', discovery, {
      type: 'discovery',
      priority: 'normal',
    });

    // 同时更新共享状态
    const key = `discovery:${from}:${Date.now()}`;
    this.setState(key, discovery, from, { ttl: this.config.messageRetention });
  }

  /**
   * 报告进度
   */
  async reportProgress(
    from: string,
    progress: {
      iteration: number;
      maxIterations: number;
      status: string;
      percentage?: number;
    }
  ): Promise<void> {
    await this.publish(from, 'progress', progress, {
      type: 'progress',
      priority: 'low',
    });

    // 更新状态
    this.setState(`progress:${from}`, progress, from);
  }

  /**
   * 报告错误
   */
  async reportError(
    from: string,
    error: {
      message: string;
      code?: string;
      fatal?: boolean;
      context?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.publish(from, 'errors', error, {
      type: 'error',
      priority: error.fatal ? 'urgent' : 'high',
    });
  }

  /**
   * 通知完成
   */
  async notifyComplete(
    from: string,
    result: {
      success: boolean;
      output?: string;
      summary?: string;
    }
  ): Promise<void> {
    await this.publish(from, 'completions', result, {
      type: 'complete',
      priority: 'high',
    });

    // 更新状态
    this.setState(`complete:${from}`, result, from);
  }

  // ==========================================================================
  // History & Stats
  // ==========================================================================

  /**
   * 获取消息历史
   */
  getHistory(options: {
    channel?: string;
    from?: string;
    to?: string;
    type?: MessageType;
    limit?: number;
    since?: number;
  } = {}): AgentMessage[] {
    let messages = [...this.messageHistory];

    // 过滤
    if (options.channel) {
      messages = messages.filter(m => m.channel === options.channel);
    }
    if (options.from) {
      messages = messages.filter(m => m.from === options.from);
    }
    if (options.to) {
      messages = messages.filter(m => m.to === options.to);
    }
    if (options.type) {
      messages = messages.filter(m => m.type === options.type);
    }
    if (options.since) {
      const since = options.since;
      messages = messages.filter(m => m.timestamp >= since);
    }

    // 限制数量
    if (options.limit) {
      messages = messages.slice(-options.limit);
    }

    return messages;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalMessages: number;
    totalSubscribers: number;
    totalStates: number;
    messagesByChannel: Record<string, number>;
    subscribersByChannel: Record<string, number>;
    pendingRequests: number;
  } {
    const messagesByChannel: Record<string, number> = {};
    const subscribersByChannel: Record<string, number> = {};

    for (const msg of this.messageHistory) {
      messagesByChannel[msg.channel] = (messagesByChannel[msg.channel] || 0) + 1;
    }

    for (const [channel, subs] of this.subscribers) {
      subscribersByChannel[channel] = subs.length;
    }

    return {
      totalMessages: this.messageHistory.length,
      totalSubscribers: Array.from(this.subscribers.values()).reduce((a, b) => a + b.length, 0),
      totalStates: this.sharedState.size,
      messagesByChannel,
      subscribersByChannel,
      pendingRequests: this.pendingRequests.size,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // 取消所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('AgentBus disposed'));
    }
    this.pendingRequests.clear();

    this.subscribers.clear();
    this.sharedState.clear();
    this.messageHistory = [];
    this.removeAllListeners();

    logger.info('AgentBus disposed');
  }

  /**
   * 重置（用于测试）
   */
  reset(): void {
    this.subscribers.clear();
    this.sharedState.clear();
    this.messageHistory = [];
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();
    logger.debug('AgentBus reset');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.messageIdCounter}`;
  }

  private addToHistory(message: AgentMessage): void {
    this.messageHistory.push(message);

    // 限制历史大小
    while (this.messageHistory.length > this.config.maxQueueSize) {
      this.messageHistory.shift();
    }
  }

  private sortByPriority(subscribers: MessageSubscriber[], messagePriority: MessagePriority): MessageSubscriber[] {
    // 对于紧急消息，不排序直接处理
    if (messagePriority === 'urgent') {
      return subscribers;
    }
    // 其他情况保持原顺序
    return subscribers;
  }

  private async dispatchMessage(message: AgentMessage, subscribers: MessageSubscriber[]): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const sub of subscribers) {
      // 跳过发送者自己
      if (sub.agentId === message.from) {
        continue;
      }

      // 检查是否是定向消息
      if (message.to && message.to !== sub.agentId) {
        continue;
      }

      // 应用过滤器
      if (sub.filter && !sub.filter(message)) {
        continue;
      }

      // 异步调用处理器
      const promise = Promise.resolve().then(async () => {
        try {
          await sub.handler(message);
        } catch (error) {
          logger.error(`Subscriber ${sub.id} error:`, error);
          this.emit('subscriber:error', { subscriberId: sub.id, error, message });
        }
      });

      promises.push(promise);
    }

    // 等待所有处理器完成（用于高优先级消息）
    if (message.priority === 'urgent') {
      await Promise.all(promises);
    }
  }

  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredStates();
      this.cleanupOldMessages();
    }, this.config.stateCleanupInterval);
  }

  private cleanupExpiredStates(): void {
    const now = Date.now();
    for (const [key, entry] of this.sharedState) {
      if (entry.expiresAt > 0 && now > entry.expiresAt) {
        this.sharedState.delete(key);
        logger.debug(`Expired state cleaned: ${key}`);
      }
    }
  }

  private cleanupOldMessages(): void {
    const cutoff = Date.now() - this.config.messageRetention;
    while (this.messageHistory.length > 0 && this.messageHistory[0].timestamp < cutoff) {
      this.messageHistory.shift();
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let busInstance: AgentBus | null = null;

/**
 * 获取 AgentBus 单例
 */
export function getAgentBus(): AgentBus {
  if (!busInstance) {
    busInstance = new AgentBus();
  }
  return busInstance;
}

/**
 * 初始化 AgentBus（自定义配置）
 */
export function initAgentBus(config: Partial<AgentBusConfig>): AgentBus {
  if (busInstance) {
    busInstance.dispose();
  }
  busInstance = new AgentBus(config);
  return busInstance;
}

/**
 * 重置 AgentBus（用于测试）
 */
export function resetAgentBus(): void {
  if (busInstance) {
    busInstance.dispose();
    busInstance = null;
  }
}
