// ============================================================================
// Teammate Types - Agent 间通信类型定义
// ============================================================================
// 参考 Claude Code 的 TeammateTool 设计
// ============================================================================

/**
 * 消息类型
 */
export type TeammateMessageType =
  | 'coordination'  // 协调通知（单向）
  | 'handoff'       // 任务交接
  | 'query'         // 查询请求（需响应）
  | 'response'      // 响应
  | 'broadcast';    // 广播

/**
 * 消息优先级
 */
export type MessagePriority = 'high' | 'normal' | 'low';

/**
 * Agent 间消息
 */
export interface TeammateMessage {
  id: string;
  from: string;           // 发送方 agent ID
  to: string;             // 接收方 agent ID 或 'all'（广播）
  type: TeammateMessageType;
  content: string;
  timestamp: number;
  metadata?: {
    taskId?: string;
    priority?: MessagePriority;
    requiresResponse?: boolean;
    responseTo?: string;   // 响应哪条消息
    expiresAt?: number;    // 过期时间
  };
}

/**
 * Agent 邮箱
 */
export interface TeammateMailbox {
  agentId: string;
  agentName: string;
  inbox: TeammateMessage[];
  outbox: TeammateMessage[];
  unreadCount: number;
}

/**
 * Agent 注册信息
 */
export interface RegisteredAgent {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'working' | 'waiting';
  registeredAt: number;
  lastActiveAt: number;
}

/**
 * TeammateService 事件
 */
export type TeammateEventType =
  | 'message:received'
  | 'message:sent'
  | 'agent:registered'
  | 'agent:unregistered'
  | 'broadcast:received';

export interface TeammateEvent {
  type: TeammateEventType;
  timestamp: number;
  data: {
    message?: TeammateMessage;
    agentId?: string;
    agentName?: string;
  };
}

export type TeammateEventCallback = (event: TeammateEvent) => void;
