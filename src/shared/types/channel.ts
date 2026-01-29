// ============================================================================
// Channel Types - Multi-channel messaging abstraction
// ============================================================================

/**
 * 通道标识符
 */
export type ChannelId = string;

/**
 * 通道类型
 */
export type ChannelType = 'http-api' | 'feishu' | 'slack' | 'discord' | 'telegram' | 'wechat';

/**
 * 通道能力定义
 */
export interface ChannelCapabilities {
  /** 是否支持流式响应 */
  streaming: boolean;
  /** 是否支持编辑消息 */
  editMessage: boolean;
  /** 是否支持删除消息 */
  deleteMessage: boolean;
  /** 是否支持添加 reaction */
  addReaction: boolean;
  /** 是否支持富文本/Markdown */
  richText: boolean;
  /** 是否支持附件 */
  attachments: boolean;
  /** 是否支持图片 */
  images: boolean;
  /** 是否支持@提及 */
  mentions: boolean;
  /** 是否支持线程回复 */
  threads: boolean;
  /** 单条消息最大长度 (字符数) */
  maxMessageLength: number;
}

/**
 * 通道元数据
 */
export interface ChannelMeta {
  /** 通道唯一 ID */
  id: ChannelId;
  /** 通道类型 */
  type: ChannelType;
  /** 通道显示名称 */
  name: string;
  /** 通道描述 */
  description?: string;
  /** 通道能力 */
  capabilities: ChannelCapabilities;
  /** 通道图标 URL */
  iconUrl?: string;
}

// ============================================================================
// Unified Message Format
// ============================================================================

/**
 * 通道附件类型
 */
export type ChannelAttachmentType = 'image' | 'file' | 'audio' | 'video' | 'link';

/**
 * 通道附件
 */
export interface ChannelAttachment {
  /** 附件 ID */
  id: string;
  /** 附件类型 */
  type: ChannelAttachmentType;
  /** 文件名 */
  name: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小 (字节) */
  size?: number;
  /** 附件 URL (如果是远程) */
  url?: string;
  /** 附件数据 (base64, 如果是本地) */
  data?: string;
  /** 缩略图 URL */
  thumbnailUrl?: string;
}

/**
 * 消息发送者
 */
export interface ChannelSender {
  /** 发送者 ID (平台内部 ID) */
  id: string;
  /** 发送者名称 */
  name: string;
  /** 发送者头像 URL */
  avatarUrl?: string;
  /** 是否是 Bot */
  isBot?: boolean;
}

/**
 * 消息上下文 (群聊/频道信息)
 */
export interface ChannelContext {
  /** 会话/聊天 ID */
  chatId: string;
  /** 会话类型 */
  chatType: 'p2p' | 'group' | 'channel';
  /** 群组/频道名称 (如果是群聊) */
  chatName?: string;
  /** 线程 ID (如果是线程回复) */
  threadId?: string;
  /** 被回复的消息 ID */
  replyToMessageId?: string;
}

/**
 * 统一通道消息格式
 */
export interface ChannelMessage {
  /** 消息 ID (平台内部) */
  id: string;
  /** 来源通道 ID */
  channelId: ChannelId;
  /** 消息发送者 */
  sender: ChannelSender;
  /** 消息上下文 */
  context: ChannelContext;
  /** 消息文本内容 */
  content: string;
  /** 附件列表 */
  attachments?: ChannelAttachment[];
  /** 消息时间戳 */
  timestamp: number;
  /** 被@提及的用户 ID 列表 */
  mentions?: string[];
  /** 原始消息对象 (平台特定) */
  raw?: unknown;
}

/**
 * 发送消息选项
 */
export interface SendMessageOptions {
  /** 目标会话 ID */
  chatId: string;
  /** 消息内容 */
  content: string;
  /** 附件 */
  attachments?: ChannelAttachment[];
  /** 回复的消息 ID */
  replyToMessageId?: string;
  /** 线程 ID */
  threadId?: string;
  /** 是否@提及 */
  mentions?: string[];
}

/**
 * 发送消息结果
 */
export interface SendMessageResult {
  /** 是否成功 */
  success: boolean;
  /** 发送的消息 ID */
  messageId?: string;
  /** 错误信息 */
  error?: string;
}

// ============================================================================
// Channel Account Configuration
// ============================================================================

/**
 * 通道账号状态
 */
export type ChannelAccountStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * HTTP API 通道配置
 */
export interface HttpApiChannelConfig {
  type: 'http-api';
  /** 监听端口 */
  port: number;
  /** 监听地址 (默认 127.0.0.1) */
  host?: string;
  /** API Key (用于认证) */
  apiKey: string;
  /** 是否启用 CORS */
  enableCors?: boolean;
  /** 允许的来源 */
  allowedOrigins?: string[];
}

/**
 * 飞书通道配置
 */
export interface FeishuChannelConfig {
  type: 'feishu';
  /** 应用 App ID */
  appId: string;
  /** 应用 App Secret */
  appSecret: string;
  /** Encrypt Key (用于消息解密) */
  encryptKey?: string;
  /** Verification Token */
  verificationToken?: string;
  /** 是否使用 WebSocket (默认 false，改用 Webhook) */
  useWebSocket?: boolean;
  /** Webhook 监听端口 (默认 3200) */
  webhookPort?: number;
  /** Webhook 监听地址 (默认 0.0.0.0) */
  webhookHost?: string;
  /** 外部 Webhook URL (用于显示配置提示) */
  webhookUrl?: string;
}

/**
 * 通道账号配置联合类型
 */
export type ChannelAccountConfig = HttpApiChannelConfig | FeishuChannelConfig;

/**
 * 通道账号
 */
export interface ChannelAccount {
  /** 账号 ID */
  id: string;
  /** 账号名称 */
  name: string;
  /** 通道类型 */
  type: ChannelType;
  /** 账号配置 */
  config: ChannelAccountConfig;
  /** 当前状态 */
  status: ChannelAccountStatus;
  /** 错误信息 (如果状态是 error) */
  errorMessage?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最后连接时间 */
  lastConnectedAt?: number;
  /** 关联的 Agent ID (路由到特定 Agent) */
  defaultAgentId?: string;
}

// ============================================================================
// Channel Events
// ============================================================================

/**
 * 通道事件类型
 */
export type ChannelEventType =
  | 'message'           // 收到新消息
  | 'message_edited'    // 消息被编辑
  | 'message_deleted'   // 消息被删除
  | 'reaction_added'    // 添加了 reaction
  | 'reaction_removed'  // 移除了 reaction
  | 'connected'         // 通道已连接
  | 'disconnected'      // 通道已断开
  | 'error';            // 发生错误

/**
 * 通道事件
 */
export interface ChannelEvent {
  /** 事件类型 */
  type: ChannelEventType;
  /** 账号 ID */
  accountId: string;
  /** 通道类型 */
  channelType: ChannelType;
  /** 事件数据 */
  data: ChannelMessage | { error: string } | null;
  /** 事件时间戳 */
  timestamp: number;
}

// ============================================================================
// IPC Types for Renderer
// ============================================================================

/**
 * 通道账号列表响应
 */
export interface ChannelAccountListResponse {
  accounts: ChannelAccount[];
}

/**
 * 添加通道账号请求
 */
export interface AddChannelAccountRequest {
  name: string;
  type: ChannelType;
  config: ChannelAccountConfig;
  defaultAgentId?: string;
}

/**
 * 更新通道账号请求
 */
export interface UpdateChannelAccountRequest {
  id: string;
  name?: string;
  config?: Partial<ChannelAccountConfig>;
  enabled?: boolean;
  defaultAgentId?: string;
}
