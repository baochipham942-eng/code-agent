// ============================================================================
// TeammateService - Agent 间通信服务
// ============================================================================
// 实现类似 Claude Code TeammateTool 的功能：
// 1. Agent 注册与发现
// 2. 消息发送与接收
// 3. 广播机制
// 4. 事件订阅
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type {
  TeammateMessage,
  TeammateMailbox,
  RegisteredAgent,
  TeammateMessageType,
  MessagePriority,
  TeammateEvent,
  TeammateEventCallback,
} from './types';

const logger = createLogger('TeammateService');

/**
 * Agent 间通信服务
 *
 * 提供 Agent 之间的直接通信能力，支持：
 * - 点对点消息
 * - 广播消息
 * - 查询/响应模式
 * - 任务交接
 */
export class TeammateService {
  private agents: Map<string, RegisteredAgent> = new Map();
  private mailboxes: Map<string, TeammateMailbox> = new Map();
  private subscribers: Map<string, TeammateEventCallback[]> = new Map();
  private globalSubscribers: TeammateEventCallback[] = [];
  private messageHistory: TeammateMessage[] = [];
  private maxHistorySize = 1000;

  // ========================================================================
  // Agent 注册
  // ========================================================================

  /**
   * 注册 Agent
   */
  register(agentId: string, name: string, role: string): void {
    if (this.agents.has(agentId)) {
      logger.warn('Agent already registered, updating', { agentId });
    }

    const agent: RegisteredAgent = {
      id: agentId,
      name,
      role,
      status: 'idle',
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.agents.set(agentId, agent);
    this.mailboxes.set(agentId, {
      agentId,
      agentName: name,
      inbox: [],
      outbox: [],
      unreadCount: 0,
    });

    logger.info('Agent registered', { agentId, name, role });
    this.emit('agent:registered', { agentId, agentName: name });
  }

  /**
   * 注销 Agent
   */
  unregister(agentId: string): void {
    if (!this.agents.has(agentId)) {
      return;
    }

    const agent = this.agents.get(agentId);
    this.agents.delete(agentId);
    this.mailboxes.delete(agentId);
    this.subscribers.delete(agentId);

    logger.info('Agent unregistered', { agentId });
    this.emit('agent:unregistered', { agentId, agentName: agent?.name });
  }

  /**
   * 更新 Agent 状态
   */
  updateStatus(agentId: string, status: RegisteredAgent['status']): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.lastActiveAt = Date.now();
    }
  }

  /**
   * 获取所有已注册的 Agent
   */
  listAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取指定 Agent
   */
  getAgent(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  // ========================================================================
  // 消息发送
  // ========================================================================

  /**
   * 发送消息
   */
  send(params: {
    from: string;
    to: string;
    type: TeammateMessageType;
    content: string;
    taskId?: string;
    priority?: MessagePriority;
    requiresResponse?: boolean;
    responseTo?: string;
  }): TeammateMessage {
    const message: TeammateMessage = {
      id: this.generateMessageId(),
      from: params.from,
      to: params.to,
      type: params.type,
      content: params.content,
      timestamp: Date.now(),
      metadata: {
        taskId: params.taskId,
        priority: params.priority || 'normal',
        requiresResponse: params.requiresResponse,
        responseTo: params.responseTo,
      },
    };

    // 更新发送方活跃时间
    this.updateStatus(params.from, 'working');

    // 添加到发送方 outbox
    const senderMailbox = this.mailboxes.get(params.from);
    if (senderMailbox) {
      senderMailbox.outbox.push(message);
    }

    // 广播或定向发送
    if (params.to === 'all') {
      this.broadcast(message, params.from);
    } else {
      this.deliver(message);
    }

    // 记录历史
    this.addToHistory(message);

    logger.debug('Message sent', {
      id: message.id,
      from: params.from,
      to: params.to,
      type: params.type,
    });

    this.emit('message:sent', { message });

    return message;
  }

  /**
   * 发送协调消息（快捷方法）
   */
  coordinate(from: string, to: string, content: string, taskId?: string): TeammateMessage {
    return this.send({
      from,
      to,
      type: 'coordination',
      content,
      taskId,
    });
  }

  /**
   * 发送任务交接（快捷方法）
   */
  handoff(from: string, to: string, content: string, taskId?: string): TeammateMessage {
    return this.send({
      from,
      to,
      type: 'handoff',
      content,
      taskId,
      priority: 'high',
    });
  }

  /**
   * 发送查询（快捷方法）
   */
  query(from: string, to: string, content: string): TeammateMessage {
    return this.send({
      from,
      to,
      type: 'query',
      content,
      requiresResponse: true,
    });
  }

  /**
   * 发送响应（快捷方法）
   */
  respond(from: string, to: string, content: string, responseTo: string): TeammateMessage {
    return this.send({
      from,
      to,
      type: 'response',
      content,
      responseTo,
    });
  }

  /**
   * 广播消息
   */
  private broadcast(message: TeammateMessage, excludeAgent: string): void {
    for (const [agentId, mailbox] of this.mailboxes) {
      if (agentId !== excludeAgent) {
        const broadcastMessage = { ...message, to: agentId };
        mailbox.inbox.push(broadcastMessage);
        mailbox.unreadCount++;
        this.notifyAgent(agentId, broadcastMessage);
      }
    }
    this.emit('broadcast:received', { message });
  }

  /**
   * 定向发送消息
   */
  private deliver(message: TeammateMessage): void {
    const mailbox = this.mailboxes.get(message.to);
    if (mailbox) {
      mailbox.inbox.push(message);
      mailbox.unreadCount++;
      this.notifyAgent(message.to, message);
    } else {
      logger.warn('Target agent not found', { to: message.to });
    }
  }

  // ========================================================================
  // 消息接收
  // ========================================================================

  /**
   * 获取未读消息
   */
  getUnread(agentId: string): TeammateMessage[] {
    const mailbox = this.mailboxes.get(agentId);
    return mailbox?.inbox.filter(m => !m.metadata?.responseTo) ?? [];
  }

  /**
   * 获取所有收件箱消息
   */
  getInbox(agentId: string): TeammateMessage[] {
    return this.mailboxes.get(agentId)?.inbox ?? [];
  }

  /**
   * 获取发件箱消息
   */
  getOutbox(agentId: string): TeammateMessage[] {
    return this.mailboxes.get(agentId)?.outbox ?? [];
  }

  /**
   * 标记消息已读
   */
  markRead(agentId: string, messageId: string): void {
    const mailbox = this.mailboxes.get(agentId);
    if (mailbox) {
      const idx = mailbox.inbox.findIndex(m => m.id === messageId);
      if (idx >= 0) {
        mailbox.inbox.splice(idx, 1);
        mailbox.unreadCount = Math.max(0, mailbox.unreadCount - 1);
      }
    }
  }

  /**
   * 清空收件箱
   */
  clearInbox(agentId: string): void {
    const mailbox = this.mailboxes.get(agentId);
    if (mailbox) {
      mailbox.inbox = [];
      mailbox.unreadCount = 0;
    }
  }

  /**
   * 获取等待响应的消息
   */
  getPendingQueries(agentId: string): TeammateMessage[] {
    const mailbox = this.mailboxes.get(agentId);
    if (!mailbox) return [];

    return mailbox.outbox.filter(m =>
      m.type === 'query' &&
      m.metadata?.requiresResponse &&
      !this.hasResponse(m.id)
    );
  }

  /**
   * 检查消息是否有响应
   */
  private hasResponse(messageId: string): boolean {
    return this.messageHistory.some(m =>
      m.type === 'response' && m.metadata?.responseTo === messageId
    );
  }

  // ========================================================================
  // 事件订阅
  // ========================================================================

  /**
   * 订阅特定 Agent 的消息
   */
  subscribe(agentId: string, callback: TeammateEventCallback): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, []);
    }
    this.subscribers.get(agentId)!.push(callback);

    // 返回取消订阅函数
    return () => {
      const subs = this.subscribers.get(agentId);
      if (subs) {
        const idx = subs.indexOf(callback);
        if (idx >= 0) subs.splice(idx, 1);
      }
    };
  }

  /**
   * 订阅全局事件
   */
  subscribeGlobal(callback: TeammateEventCallback): () => void {
    this.globalSubscribers.push(callback);
    return () => {
      const idx = this.globalSubscribers.indexOf(callback);
      if (idx >= 0) this.globalSubscribers.splice(idx, 1);
    };
  }

  /**
   * 通知 Agent 收到消息
   */
  private notifyAgent(agentId: string, message: TeammateMessage): void {
    const event: TeammateEvent = {
      type: 'message:received',
      timestamp: Date.now(),
      data: { message, agentId },
    };

    const subs = this.subscribers.get(agentId);
    if (subs) {
      for (const callback of subs) {
        try {
          callback(event);
        } catch (err) {
          logger.error('Subscriber callback error', { agentId, error: err });
        }
      }
    }
  }

  /**
   * 触发全局事件
   */
  private emit(type: TeammateEvent['type'], data: TeammateEvent['data']): void {
    const event: TeammateEvent = {
      type,
      timestamp: Date.now(),
      data,
    };

    for (const callback of this.globalSubscribers) {
      try {
        callback(event);
      } catch (err) {
        logger.error('Global subscriber callback error', { error: err });
      }
    }
  }

  // ========================================================================
  // 工具方法
  // ========================================================================

  /**
   * 生成消息 ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(message: TeammateMessage): void {
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }
  }

  /**
   * 获取消息历史
   */
  getHistory(limit = 100): TeammateMessage[] {
    return this.messageHistory.slice(-limit);
  }

  /**
   * 获取两个 Agent 间的对话
   */
  getConversation(agentA: string, agentB: string, limit = 50): TeammateMessage[] {
    return this.messageHistory
      .filter(m =>
        (m.from === agentA && m.to === agentB) ||
        (m.from === agentB && m.to === agentA)
      )
      .slice(-limit);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    agentCount: number;
    totalMessages: number;
    activeAgents: number;
  } {
    const now = Date.now();
    const activeThreshold = 5 * 60 * 1000; // 5 分钟

    return {
      agentCount: this.agents.size,
      totalMessages: this.messageHistory.length,
      activeAgents: Array.from(this.agents.values())
        .filter(a => now - a.lastActiveAt < activeThreshold).length,
    };
  }

  // ========================================================================
  // Agent Teams P2 增强方法
  // ========================================================================

  /**
   * 订阅特定 Agent 的所有消息（让 UI 可以订阅）
   */
  subscribeToAgent(agentId: string, callback: TeammateEventCallback): () => void {
    return this.subscribe(agentId, callback);
  }

  /**
   * 用户直接给 Agent 发消息
   */
  onUserMessage(agentId: string, message: string): TeammateMessage {
    const userAgentId = 'user';

    // 确保用户已注册
    if (!this.agents.has(userAgentId)) {
      this.register(userAgentId, 'User', 'human');
    }

    return this.send({
      from: userAgentId,
      to: agentId,
      type: 'coordination',
      content: message,
      priority: 'high',
    });
  }

  /**
   * 发送 plan review 请求（teammate → lead）
   */
  sendPlanReview(fromAgentId: string, toAgentId: string, planContent: string, taskId?: string): TeammateMessage {
    return this.send({
      from: fromAgentId,
      to: toAgentId,
      type: 'query',
      content: `[Plan Review]\n${planContent}`,
      taskId,
      priority: 'high',
      requiresResponse: true,
    });
  }

  /**
   * 审批 plan（lead → teammate）
   */
  approvePlan(fromAgentId: string, toAgentId: string, responseTo: string, feedback?: string): TeammateMessage {
    return this.respond(
      fromAgentId,
      toAgentId,
      `[Plan Approved]${feedback ? `\n${feedback}` : ''}`,
      responseTo
    );
  }

  /**
   * 驳回 plan（lead → teammate）
   */
  rejectPlan(fromAgentId: string, toAgentId: string, responseTo: string, reason: string): TeammateMessage {
    return this.respond(
      fromAgentId,
      toAgentId,
      `[Plan Rejected]\n${reason}`,
      responseTo
    );
  }

  /**
   * 重置服务
   */
  reset(): void {
    this.agents.clear();
    this.mailboxes.clear();
    this.subscribers.clear();
    this.globalSubscribers = [];
    this.messageHistory = [];
    logger.info('TeammateService reset');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let serviceInstance: TeammateService | null = null;

export function getTeammateService(): TeammateService {
  if (!serviceInstance) {
    serviceInstance = new TeammateService();
  }
  return serviceInstance;
}

export function resetTeammateService(): void {
  serviceInstance?.reset();
  serviceInstance = null;
}
