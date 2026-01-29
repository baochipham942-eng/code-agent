// ============================================================================
// Channel Plugin Interface - 通道插件抽象接口
// ============================================================================

import type {
  ChannelId,
  ChannelType,
  ChannelMeta,
  ChannelMessage,
  ChannelAccountConfig,
  ChannelAccountStatus,
  SendMessageOptions,
  SendMessageResult,
  ChannelEvent,
} from '../../shared/types/channel';
import { EventEmitter } from 'events';

/**
 * 通道插件接口
 *
 * 所有通道实现都必须实现此接口，提供统一的消息收发能力
 */
export interface IChannelPlugin extends EventEmitter {
  /** 通道元数据 */
  readonly meta: ChannelMeta;

  /** 当前连接状态 */
  readonly status: ChannelAccountStatus;

  /** 账号 ID */
  readonly accountId: string;

  // ========== 生命周期方法 ==========

  /**
   * 初始化通道
   * @param config 通道配置
   */
  initialize(config: ChannelAccountConfig): Promise<void>;

  /**
   * 连接到通道服务
   */
  connect(): Promise<void>;

  /**
   * 断开连接
   */
  disconnect(): Promise<void>;

  /**
   * 销毁通道实例，释放所有资源
   */
  destroy(): Promise<void>;

  // ========== 消息收发 ==========

  /**
   * 发送消息
   * @param options 发送选项
   */
  sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;

  // ========== 可选方法 ==========

  /**
   * 编辑消息 (可选)
   * @param messageId 消息 ID
   * @param newContent 新内容
   */
  editMessage?(messageId: string, newContent: string): Promise<SendMessageResult>;

  /**
   * 删除消息 (可选)
   * @param messageId 消息 ID
   */
  deleteMessage?(messageId: string): Promise<boolean>;

  /**
   * 添加 reaction (可选)
   * @param messageId 消息 ID
   * @param reaction reaction 标识
   */
  addReaction?(messageId: string, reaction: string): Promise<boolean>;

  /**
   * 移除 reaction (可选)
   * @param messageId 消息 ID
   * @param reaction reaction 标识
   */
  removeReaction?(messageId: string, reaction: string): Promise<boolean>;

  // ========== 事件 ==========
  // 通过 EventEmitter 发出以下事件:
  // - 'message': (message: ChannelMessage) => void
  // - 'status_change': (status: ChannelAccountStatus) => void
  // - 'error': (error: Error) => void
}

/**
 * 通道插件事件类型
 */
export interface ChannelPluginEvents {
  message: (message: ChannelMessage) => void;
  status_change: (status: ChannelAccountStatus, error?: string) => void;
  error: (error: Error) => void;
}

/**
 * 通道插件基类
 *
 * 提供通用实现，具体通道只需实现特定方法
 */
export abstract class BaseChannelPlugin extends EventEmitter implements IChannelPlugin {
  abstract readonly meta: ChannelMeta;
  protected _status: ChannelAccountStatus = 'disconnected';
  protected _accountId: string;
  protected config: ChannelAccountConfig | null = null;

  constructor(accountId: string) {
    super();
    this._accountId = accountId;
  }

  get status(): ChannelAccountStatus {
    return this._status;
  }

  get accountId(): string {
    return this._accountId;
  }

  protected setStatus(status: ChannelAccountStatus, error?: string): void {
    this._status = status;
    this.emit('status_change', status, error);
  }

  abstract initialize(config: ChannelAccountConfig): Promise<void>;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract destroy(): Promise<void>;
  abstract sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;
}

/**
 * 通道插件工厂函数类型
 */
export type ChannelPluginFactory = (accountId: string) => IChannelPlugin;

/**
 * 通道插件注册信息
 */
export interface ChannelPluginRegistration {
  /** 通道类型 */
  type: ChannelType;
  /** 通道元数据 */
  meta: Omit<ChannelMeta, 'id'>;
  /** 创建插件实例的工厂函数 */
  factory: ChannelPluginFactory;
}

/**
 * 通道消息处理器
 * 用于将收到的消息路由到 Agent 系统
 */
export type ChannelMessageHandler = (
  accountId: string,
  message: ChannelMessage
) => Promise<void>;

/**
 * 通道响应回调
 * Agent 处理完成后调用此回调发送响应
 */
export interface ChannelResponseCallback {
  /** 发送文本响应 */
  sendText(content: string): Promise<SendMessageResult>;
  /** 流式发送 (如果支持) */
  sendStream?(stream: AsyncIterable<string>): Promise<SendMessageResult>;
  /** 编辑之前的消息 (如果支持) */
  editMessage?(messageId: string, content: string): Promise<SendMessageResult>;
}
