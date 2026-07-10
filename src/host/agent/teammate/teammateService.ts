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
import {
  createScopedSwarmMessageId,
  getSwarmRunScopeKey,
  isSameSwarmRun,
  parseScopedSwarmAgentId,
  parseScopedSwarmMessageId,
  type SwarmEvent,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../../shared/contract/swarm';
import { getEventBus } from '../../services/eventing/bus';
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

interface ScopedMessageHistory {
  scope: SwarmRunScope;
  messages: TeammateMessage[];
}

interface MessageIdentity {
  id?: string;
  timestamp?: number;
}

type AgentDiscoveryScope = Pick<SwarmRunScope, 'sessionId'>
  & Partial<Pick<SwarmRunScope, 'runId' | 'treeId'>>;

type SendMessageParams = {
  from: string;
  to: string;
  type: TeammateMessageType;
  content: string;
  taskId?: string;
  priority?: MessagePriority;
  requiresResponse?: boolean;
  responseTo?: string;
  scope?: SwarmRunScope;
  id?: string;
  timestamp?: number;
};

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
  private legacyMessageHistory: TeammateMessage[] = [];
  private scopedMessageHistory = new Map<string, ScopedMessageHistory>();
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
  listAgents(scope?: AgentDiscoveryScope): RegisteredAgent[] {
    const agents = Array.from(this.agents.values());
    if (!scope) return agents;
    return agents.filter((agent) => {
      const parsed = parseScopedSwarmAgentId(agent.id);
      return Boolean(parsed && this.matchesDiscoveryScope(parsed.scope, scope));
    });
  }

  /**
   * 获取指定 Agent
   */
  getAgent(agentId: string, scope?: SwarmRunRef): RegisteredAgent | undefined {
    const agent = this.agents.get(agentId);
    if (!agent || !scope) return agent;
    const parsed = parseScopedSwarmAgentId(agentId);
    return parsed && this.matchesScopeRef(parsed.scope, scope) ? agent : undefined;
  }

  // ========================================================================
  // 消息发送
  // ========================================================================

  /**
   * 发送消息
   */
  send(params: SendMessageParams): TeammateMessage {
    const scope = this.resolveMessageScope(params.scope, params.from, params.to);
    const message: TeammateMessage = {
      id: this.resolveMessageId(scope, params.id),
      from: params.from,
      to: params.to,
      type: params.type,
      content: params.content,
      timestamp: params.timestamp ?? Date.now(),
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
      this.broadcast(message, params.from, scope);
    } else {
      this.deliver(message, scope);
    }

    // 记录历史
    this.addToHistory(message, scope);
    if (scope) {
      this.publishSwarmMessage(scope, message);
    }

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
  respond(
    from: string,
    to: string,
    content: string,
    responseTo: string,
    scope?: SwarmRunScope,
  ): TeammateMessage {
    return this.send({
      from,
      to,
      type: 'response',
      content,
      responseTo,
      scope,
    });
  }

  /**
   * 广播消息
   */
  private broadcast(
    message: TeammateMessage,
    excludeAgent: string,
    scope?: SwarmRunScope,
  ): void {
    for (const [agentId, mailbox] of this.mailboxes) {
      if (agentId === excludeAgent) continue;
      if (scope) {
        const parsed = parseScopedSwarmAgentId(agentId);
        if (!parsed || !this.isSameScope(parsed.scope, scope)) continue;
      } else if (parseScopedSwarmAgentId(agentId)) {
        // Legacy broadcasts have no session/run authority. They may continue
        // serving legacy mailboxes, but must never fan out into scoped Teams.
        continue;
      }
      const broadcastMessage = { ...message, to: agentId };
      mailbox.inbox.push(broadcastMessage);
      mailbox.unreadCount++;
      this.notifyAgent(agentId, broadcastMessage);
    }
    this.emit('broadcast:received', { message });
  }

  /**
   * 定向发送消息
   */
  private deliver(message: TeammateMessage, scope?: SwarmRunScope): void {
    if (scope) {
      const target = parseScopedSwarmAgentId(message.to);
      if (target && !this.isSameScope(target.scope, scope)) {
        logger.warn('Refusing cross-run teammate delivery', {
          from: message.from,
          to: message.to,
          sessionId: scope.sessionId,
          runId: scope.runId,
        });
        return;
      }
      // Plain logical ids have process-global mailboxes. A scoped Team message
      // must not enter them; callers still retain the message in the scoped ledger.
      if (!target) return;
    }
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
  getUnread(agentId: string, scope?: SwarmRunRef): TeammateMessage[] {
    if (scope && !this.agentMatchesRun(agentId, scope)) return [];
    const mailbox = this.mailboxes.get(agentId);
    return mailbox?.inbox.filter(m => !m.metadata?.responseTo) ?? [];
  }

  /**
   * 获取所有收件箱消息
   */
  getInbox(agentId: string, scope?: SwarmRunRef): TeammateMessage[] {
    if (scope && !this.agentMatchesRun(agentId, scope)) return [];
    return this.mailboxes.get(agentId)?.inbox ?? [];
  }

  /**
   * 获取发件箱消息
   */
  getOutbox(agentId: string, scope?: SwarmRunRef): TeammateMessage[] {
    if (scope && !this.agentMatchesRun(agentId, scope)) return [];
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
    const scope = parseScopedSwarmAgentId(agentId)?.scope;

    return mailbox.outbox.filter(m =>
      m.type === 'query' &&
      m.metadata?.requiresResponse &&
      !this.hasResponse(m.id, scope)
    );
  }

  /**
   * 检查消息是否有响应
   */
  private hasResponse(messageId: string, scope?: SwarmRunScope): boolean {
    return this.getHistoryForScope(scope).some(m =>
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
  private generateMessageId(scope?: SwarmRunScope): string {
    const localId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    return scope ? createScopedSwarmMessageId(scope, localId) : localId;
  }

  private resolveMessageId(scope: SwarmRunScope | undefined, suppliedId?: string): string {
    if (!suppliedId) return this.generateMessageId(scope);
    if (!scope) return suppliedId;

    const parsed = parseScopedSwarmMessageId(suppliedId);
    if (!parsed) return createScopedSwarmMessageId(scope, suppliedId);
    if (!this.isSameScope(parsed.scope, scope)) {
      throw new Error('Scoped teammate message id belongs to a different Team run');
    }
    return suppliedId;
  }

  private isSameScope(left: SwarmRunScope, right: SwarmRunScope): boolean {
    return isSameSwarmRun(left, right) && left.treeId === right.treeId;
  }

  private agentMatchesRun(agentId: string, scope: SwarmRunRef): boolean {
    const parsed = parseScopedSwarmAgentId(agentId);
    return Boolean(parsed && this.matchesScopeRef(parsed.scope, scope));
  }

  private matchesScopeRef(actual: SwarmRunScope, expected: SwarmRunRef): boolean {
    if (!isSameSwarmRun(actual, expected)) return false;
    return !('treeId' in expected) || actual.treeId === expected.treeId;
  }

  private matchesDiscoveryScope(actual: SwarmRunScope, expected: AgentDiscoveryScope): boolean {
    if (actual.sessionId !== expected.sessionId) return false;
    if (expected.runId !== undefined && actual.runId !== expected.runId) return false;
    return expected.treeId === undefined || actual.treeId === expected.treeId;
  }

  private resolveMessageScope(
    explicitScope: SwarmRunScope | undefined,
    from: string,
    to: string,
  ): SwarmRunScope | undefined {
    const fromScope = parseScopedSwarmAgentId(from)?.scope;
    const toScope = to === 'all' ? undefined : parseScopedSwarmAgentId(to)?.scope;
    const inferred = explicitScope ?? fromScope ?? toScope;
    if (!inferred) return undefined;

    if (from !== 'user' && !fromScope) {
      throw new Error(`Scoped teammate sender must use a composite agent id: ${from}`);
    }
    if (to !== 'all' && !toScope) {
      throw new Error(`Scoped teammate target must use a composite agent id: ${to}`);
    }

    for (const candidate of [fromScope, toScope]) {
      if (candidate && !this.isSameScope(candidate, inferred)) {
        throw new Error(
          `Cross-run teammate message refused: ${inferred.sessionId}/${inferred.runId}`,
        );
      }
    }
    return inferred;
  }

  private getOrCreateHistory(scope?: SwarmRunScope): TeammateMessage[] {
    if (!scope) return this.legacyMessageHistory;
    const key = getSwarmRunScopeKey(scope);
    let entry = this.scopedMessageHistory.get(key);
    if (!entry) {
      entry = { scope: { ...scope }, messages: [] };
      this.scopedMessageHistory.set(key, entry);
    }
    return entry.messages;
  }

  private getHistoryForScope(scope?: SwarmRunScope): TeammateMessage[] {
    if (!scope) return this.legacyMessageHistory;
    return this.scopedMessageHistory.get(getSwarmRunScopeKey(scope))?.messages ?? [];
  }

  private getHistoryForRun(scope: SwarmRunRef): TeammateMessage[] {
    const messages: TeammateMessage[] = [];
    for (const entry of this.scopedMessageHistory.values()) {
      if (this.matchesScopeRef(entry.scope, scope)) {
        messages.push(...entry.messages);
      }
    }
    return messages.sort((left, right) => left.timestamp - right.timestamp);
  }

  private publishSwarmMessage(scope: SwarmRunScope, message: TeammateMessage): void {
    const isUserMessage = message.from === 'user';
    const event: SwarmEvent = {
      type: isUserMessage ? 'swarm:user:message' : 'swarm:agent:message',
      sessionId: scope.sessionId,
      runId: scope.runId,
      treeId: scope.treeId,
      parentNativeRunId: scope.parentNativeRunId,
      timestamp: message.timestamp,
      data: {
        agentId: isUserMessage ? message.to : message.from,
        message: {
          id: message.id,
          from: message.from,
          to: message.to,
          content: message.content,
          messageType: message.type,
        },
      },
    };
    const busType = event.type.slice('swarm:'.length);
    getEventBus().publish('swarm', busType, event, {
      sessionId: scope.sessionId,
      bridgeToRenderer: false,
    });
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(message: TeammateMessage, scope?: SwarmRunScope): void {
    const history = this.getOrCreateHistory(scope);
    history.push(message);
    if (history.length > this.maxHistorySize) {
      history.shift();
    }
  }

  /**
   * 获取消息历史
   */
  getHistory(limit?: number): TeammateMessage[];
  getHistory(scope: SwarmRunRef, limit?: number): TeammateMessage[];
  getHistory(scopeOrLimit: SwarmRunRef | number = 100, scopedLimit = 100): TeammateMessage[] {
    if (typeof scopeOrLimit === 'number') {
      return this.legacyMessageHistory.slice(-scopeOrLimit);
    }
    return this.getHistoryForRun(scopeOrLimit).slice(-scopedLimit);
  }

  /**
   * 获取两个 Agent 间的对话
   */
  getConversation(
    agentA: string,
    agentB: string,
    limit = 50,
    scope?: SwarmRunRef,
  ): TeammateMessage[] {
    const history = scope
      ? this.getHistoryForRun(scope)
      : this.getHistoryForScope(parseScopedSwarmAgentId(agentA)?.scope);
    return history
      .filter(m =>
        (m.from === agentA && m.to === agentB) ||
        (m.from === agentB && m.to === agentA)
      )
      .slice(-limit);
  }

  /**
   * 获取统计信息
   */
  getStats(scope?: SwarmRunRef): {
    agentCount: number;
    totalMessages: number;
    activeAgents: number;
  } {
    const now = Date.now();
    const activeThreshold = 5 * 60 * 1000; // 5 分钟

    const agents = scope
      ? Array.from(this.agents.values()).filter((agent) => {
          const parsed = parseScopedSwarmAgentId(agent.id);
          return parsed ? this.matchesScopeRef(parsed.scope, scope) : false;
        })
      : Array.from(this.agents.values());
    return {
      agentCount: agents.length,
      totalMessages: scope
        ? this.getHistoryForRun(scope).length
        : this.legacyMessageHistory.length,
      activeAgents: agents
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
  onUserMessage(agentId: string, message: string): TeammateMessage;
  onUserMessage(
    scope: SwarmRunScope,
    agentId: string,
    message: string,
    identity?: MessageIdentity,
  ): TeammateMessage;
  onUserMessage(
    scopeOrAgentId: SwarmRunScope | string,
    agentIdOrMessage: string,
    messageOrUndefined?: string,
    identity: MessageIdentity = {},
  ): TeammateMessage {
    const scoped = typeof scopeOrAgentId !== 'string';
    const scope = scoped ? scopeOrAgentId : undefined;
    const agentId = scoped ? agentIdOrMessage : scopeOrAgentId;
    const message = scoped ? (messageOrUndefined ?? '') : agentIdOrMessage;
    const userAgentId = 'user';

    // Legacy callers retain the historical user mailbox. Scoped Team messages
    // deliberately avoid it because one process-global mailbox would mix runs.
    if (!scope && !this.agents.has(userAgentId)) {
      this.register(userAgentId, 'User', 'human');
    }

    return this.send({
      from: userAgentId,
      to: agentId,
      type: 'coordination',
      content: message,
      priority: 'high',
      scope,
      id: identity.id,
      timestamp: identity.timestamp,
    });
  }

  /**
   * 发送 plan review 请求（teammate → lead）
   */
  sendPlanReview(
    fromAgentId: string,
    toAgentId: string,
    planContent: string,
    taskId?: string,
    scope?: SwarmRunScope,
  ): TeammateMessage {
    return this.send({
      from: fromAgentId,
      to: toAgentId,
      type: 'query',
      content: `[Plan Review]\n${planContent}`,
      taskId,
      priority: 'high',
      requiresResponse: true,
      scope,
    });
  }

  /**
   * 审批 plan（lead → teammate）
   */
  approvePlan(
    fromAgentId: string,
    toAgentId: string,
    responseTo: string,
    feedback?: string,
    scope?: SwarmRunScope,
  ): TeammateMessage {
    return this.send({
      from: fromAgentId,
      to: toAgentId,
      type: 'response',
      content: `[Plan Approved]${feedback ? `\n${feedback}` : ''}`,
      responseTo,
      scope,
    });
  }

  /**
   * 驳回 plan（lead → teammate）
   */
  rejectPlan(
    fromAgentId: string,
    toAgentId: string,
    responseTo: string,
    reason: string,
    scope?: SwarmRunScope,
  ): TeammateMessage {
    return this.send({
      from: fromAgentId,
      to: toAgentId,
      type: 'response',
      content: `[Plan Rejected]\n${reason}`,
      responseTo,
      scope,
    });
  }

  /**
   * 导出当前状态（用于持久化）
   */
  exportState(): {
    agents: RegisteredAgent[];
    messageHistory: TeammateMessage[];
    scopedMessageHistory: ScopedMessageHistory[];
  } {
    return {
      agents: Array.from(this.agents.values()),
      messageHistory: [...this.legacyMessageHistory],
      scopedMessageHistory: Array.from(this.scopedMessageHistory.values()).map((entry) => ({
        scope: { ...entry.scope },
        messages: [...entry.messages],
      })),
    };
  }

  /**
   * 导入状态（用于恢复）
   */
  importState(state: {
    agents: RegisteredAgent[];
    messageHistory?: TeammateMessage[];
    scopedMessageHistory?: ScopedMessageHistory[];
  }): void {
    for (const agent of state.agents) {
      this.agents.set(agent.id, agent);
      if (!this.mailboxes.has(agent.id)) {
        this.mailboxes.set(agent.id, {
          agentId: agent.id,
          agentName: agent.name,
          inbox: [],
          outbox: [],
          unreadCount: 0,
        });
      }
    }
    if (state.messageHistory) {
      this.legacyMessageHistory.push(...state.messageHistory);
      // Trim to max size
      while (this.legacyMessageHistory.length > this.maxHistorySize) {
        this.legacyMessageHistory.shift();
      }
    }
    for (const entry of state.scopedMessageHistory ?? []) {
      const messages = entry.messages.slice(-this.maxHistorySize);
      this.scopedMessageHistory.set(getSwarmRunScopeKey(entry.scope), {
        scope: { ...entry.scope },
        messages,
      });
    }
    for (const entry of this.scopedMessageHistory.values()) {
      for (const message of entry.messages) {
        const parsedFrom = parseScopedSwarmAgentId(message.from);
        const parsedTo = parseScopedSwarmAgentId(message.to);
        if (
          (message.from !== 'user' && !parsedFrom)
          || (message.to !== 'all' && !parsedTo)
          || (parsedFrom && !this.isSameScope(parsedFrom.scope, entry.scope))
          || (parsedTo && !this.isSameScope(parsedTo.scope, entry.scope))
        ) {
          throw new Error(`Imported teammate message ${message.id} has a mismatched run scope`);
        }
      }
    }
    logger.info(`State imported: ${state.agents.length} agents`);
  }

  /**
   * 重置服务
   */
  reset(): void {
    this.agents.clear();
    this.mailboxes.clear();
    this.subscribers.clear();
    this.globalSubscribers = [];
    this.legacyMessageHistory = [];
    this.scopedMessageHistory.clear();
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
