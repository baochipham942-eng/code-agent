// ============================================================================
// TaskManager - Multi-session task orchestration
// Wave 5: 多任务并行支持
// ============================================================================

import { EventEmitter } from 'events';
import type { AgentEvent, Message, MessageMetadata, ToolCall } from '../../shared/contract';
import { AgentOrchestrator, type AgentOrchestratorConfig } from '../agent/agentOrchestrator';
import type { AgentRunOptions } from '../research/types';
import type { ConfigService } from '../services/core/configService';
import type { PlanningService } from '../planning';
import { Semaphore } from './Semaphore';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import { app, BrowserWindow } from '../platform';
import { DAG_CHANNELS } from '../../shared/ipc/channels';

const logger = createLogger('TaskManager');
const CONTEXT_ASSEMBLY_PERSISTED_MESSAGE = Symbol.for('code-agent.contextAssembly.persistedMessage');

function wasMessagePersistedByContextAssembly(message: Message): boolean {
  return Boolean((message as any)[CONTEXT_ASSEMBLY_PERSISTED_MESSAGE]);
}

// ============================================================================
// Types
// ============================================================================

/**
 * 会话运行状态
 */
export type SessionStatus = 'idle' | 'running' | 'paused' | 'queued' | 'cancelling' | 'error';

/**
 * 会话状态信息
 */
export interface SessionState {
  /** 当前状态 */
  status: SessionStatus;
  /** 在队列中的位置（仅 queued 状态有效）*/
  queuePosition?: number;
  /** 任务开始时间 */
  startTime?: number;
  /** 错误信息（仅 error 状态有效）*/
  error?: string;
}

/**
 * TaskManager 配置
 */
export interface TaskManagerConfig {
  /** 最大并发任务数，默认 3 */
  maxConcurrentTasks: number;
  /** 中断超时时间（毫秒），超时后降级为强制取消，默认 5000 */
  interruptTimeout: number;
  /** 排队超时时间（毫秒），超时后自动取消，默认 300000 (5分钟) */
  queueTimeout: number;
}

/**
 * TaskManager 事件类型
 */
export type TaskManagerEventType =
  | 'state_change'      // 会话状态变化
  | 'queue_update'      // 队列更新
  | 'task_started'      // 任务开始执行
  | 'task_completed'    // 任务完成
  | 'task_error'        // 任务出错
  | 'task_cancelled';   // 任务取消

export interface TaskManagerEvent {
  type: TaskManagerEventType;
  sessionId: string;
  data?: unknown;
}

/**
 * 内部 Orchestrator 包装
 */
interface OrchestratorWrapper {
  orchestrator: AgentOrchestrator;
  sessionId: string;
  createdAt: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: TaskManagerConfig = {
  maxConcurrentTasks: 3,
  interruptTimeout: 5000,
  queueTimeout: 300000,
};

// ============================================================================
// TaskManager Class
// ============================================================================

/**
 * TaskManager - 多会话任务编排器
 *
 * 负责管理多个会话的并发执行：
 * - 控制同时运行的会话数量（信号量）
 * - 管理等待队列
 * - 支持软中断和硬取消
 * - 会话状态追踪和通知
 *
 * @example
 * ```typescript
 * const taskManager = getTaskManager();
 *
 * // 启动任务（可能排队）
 * await taskManager.startTask('session-1', '帮我写一个贪吃蛇游戏');
 *
 * // 取消任务
 * await taskManager.cancelTask('session-1');
 *
 * // 监听状态变化
 * taskManager.on('state_change', (event) => {
 *   console.log(`Session ${event.sessionId} is now ${event.data.status}`);
 * });
 * ```
 */
export class TaskManager extends EventEmitter {
  private config: TaskManagerConfig;
  private semaphore: Semaphore;
  private activeOrchestrators: Map<string, OrchestratorWrapper> = new Map();
  private sessionStates: Map<string, SessionState> = new Map();
  private waitingQueue: string[] = [];
  private queueTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private cancellingSessions: Set<string> = new Set();
  private cancelledEventEmitted: Set<string> = new Set();

  // 依赖注入
  private configService: ConfigService | null = null;
  private planningService: PlanningService | undefined;
  private onAgentEvent: ((sessionId: string, event: AgentEvent) => void) | null = null;

  // 当前活跃会话 ID（用于 getAgentOrchestrator 兼容层）
  private currentSessionId: string | null = null;

  // Per-session turnState for message aggregation (moved from createAgentRuntime)
  private turnStateBySession: Map<string, {
    messageId: string;
    toolCalls: ToolCall[];
    content: string;
  }> = new Map();

  constructor(config: Partial<TaskManagerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.semaphore = new Semaphore(this.config.maxConcurrentTasks);
    logger.info(`TaskManager initialized with max ${this.config.maxConcurrentTasks} concurrent tasks`);
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * 初始化 TaskManager 依赖
   */
  initialize(deps: {
    configService: ConfigService;
    planningService?: PlanningService;
    onAgentEvent: (sessionId: string, event: AgentEvent) => void;
  }): void {
    this.configService = deps.configService;
    this.planningService = deps.planningService;
    this.onAgentEvent = deps.onAgentEvent;
    logger.info('TaskManager dependencies initialized');
  }

  /**
   * 设置 PlanningService（在 bootstrap Phase 4b 初始化后调用）
   * 同时更新已存在的 orchestrator 实例
   */
  setPlanningService(service: PlanningService): void {
    this.planningService = service;
    // Update existing orchestrators with the new planning service
    for (const [sessionId, wrapper] of this.activeOrchestrators) {
      wrapper.orchestrator.setPlanningService(service);
      logger.debug(`Updated planningService for session ${sessionId}`);
    }
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 启动任务
   *
   * 如果有可用的并发槽位，立即执行；否则加入等待队列。
   *
   * @param sessionId - 会话 ID
   * @param message - 用户消息
   * @param attachments - 可选的附件
   * @returns Promise 在任务完成后 resolve
   */
  async startTask(
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    if (!this.configService || !this.onAgentEvent) {
      throw new Error('TaskManager not initialized. Call initialize() first.');
    }

    // 检查是否已经在运行或排队
    const currentState = this.sessionStates.get(sessionId);
    if (
      currentState?.status === 'running'
      || currentState?.status === 'paused'
      || currentState?.status === 'queued'
      || currentState?.status === 'cancelling'
    ) {
      logger.warn(`Session ${sessionId} is already ${currentState.status}`);
      throw new Error(`Session ${sessionId} is already ${currentState.status}`);
    }

    // 尝试获取信号量
    if (this.semaphore.tryAcquire()) {
      // 立即执行
      await this.executeTask(sessionId, message, attachments, options, messageMetadata);
    } else {
      // 加入队列
      await this.enqueueTask(sessionId, message, attachments, options, messageMetadata);
    }
  }

  /**
   * 中断并继续当前会话；如果当前没有 TaskManager-owned run，则作为新任务启动。
   */
  async interruptAndContinue(
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
    clientMessageId?: string,
  ): Promise<void> {
    const state = this.getSessionState(sessionId);

    if (state.status === 'queued') {
      await this.cancelTask(sessionId);
      await this.startTask(sessionId, message, attachments, options, messageMetadata);
      return;
    }

    if (state.status === 'running' || state.status === 'paused' || state.status === 'cancelling') {
      const wrapper = this.activeOrchestrators.get(sessionId);
      if (!wrapper) {
        logger.warn(`No orchestrator found for session ${sessionId}; starting a fresh task for interrupt`);
        this.cleanupSession(sessionId);
        await this.startTask(sessionId, message, attachments, options, messageMetadata);
        return;
      }

      await wrapper.orchestrator.interruptAndContinue(
        message,
        attachments,
        options,
        messageMetadata,
        clientMessageId,
      );
      return;
    }

    await this.startTask(sessionId, message, attachments, options, messageMetadata);
  }

  /**
   * 中断任务（软中断）
   *
   * 等待当前工具执行完成后停止，有超时保护。
   * 超时后自动降级为强制取消。
   *
   * @param sessionId - 会话 ID
   */
  async interruptTask(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId);
    if (state?.status !== 'running') {
      logger.warn(`Cannot interrupt session ${sessionId}: not running`);
      return;
    }

    logger.info(`Interrupting session ${sessionId} (soft interrupt)`);
    this.cancellingSessions.add(sessionId);
    this.updateSessionState(sessionId, { status: 'cancelling' });

    const wrapper = this.activeOrchestrators.get(sessionId);
    if (!wrapper) {
      logger.warn(`No orchestrator found for session ${sessionId}`);
      this.finishCancelledSession(sessionId, { clearMarker: true });
      return;
    }

    // 设置超时保护
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.warn(`Interrupt timeout for session ${sessionId}, forcing cancel`);
        resolve();
      }, this.config.interruptTimeout);
    });

    // 等待取消完成或超时
    const cancelPromise = wrapper.orchestrator.cancel();

    await Promise.race([cancelPromise, timeoutPromise]);

    // executeTask owns the terminal state transition once sendMessage unwinds.
  }

  /**
   * 取消任务（硬取消）
   *
   * 立即停止执行，不等待当前工具完成。
   *
   * @param sessionId - 会话 ID
   */
  async cancelTask(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      logger.warn(`Session ${sessionId} not found`);
      return;
    }

    if (state.status === 'queued') {
      // 从队列中移除
      this.removeFromQueue(sessionId);
      this.updateSessionState(sessionId, { status: 'idle' });
      this.emitEvent('task_cancelled', sessionId);
      return;
    }

    if (state.status === 'running' || state.status === 'paused' || state.status === 'cancelling') {
      logger.info(`Cancelling session ${sessionId} (hard cancel)`);
      this.cancellingSessions.add(sessionId);
      this.updateSessionState(sessionId, { status: 'cancelling' });

      const wrapper = this.activeOrchestrators.get(sessionId);
      if (wrapper) {
        await wrapper.orchestrator.cancel();
      } else {
        this.finishCancelledSession(sessionId, { clearMarker: true });
      }
      // executeTask owns the terminal state transition once sendMessage unwinds.
    }
  }

  /**
   * 暂停任务。
   */
  pauseTask(sessionId: string): boolean {
    const state = this.sessionStates.get(sessionId);
    if (state?.status !== 'running') {
      logger.warn(`Cannot pause session ${sessionId}: not running`);
      return false;
    }

    const wrapper = this.activeOrchestrators.get(sessionId);
    if (!wrapper) {
      logger.warn(`No orchestrator found for session ${sessionId}`);
      return false;
    }

    wrapper.orchestrator.pause();
    this.updateSessionState(sessionId, { status: 'paused' });
    return true;
  }

  /**
   * 恢复任务。
   */
  resumeTask(sessionId: string): boolean {
    const state = this.sessionStates.get(sessionId);
    if (state?.status !== 'paused') {
      logger.warn(`Cannot resume session ${sessionId}: not paused`);
      return false;
    }

    const wrapper = this.activeOrchestrators.get(sessionId);
    if (!wrapper) {
      logger.warn(`No orchestrator found for session ${sessionId}`);
      return false;
    }

    wrapper.orchestrator.resume();
    this.updateSessionState(sessionId, { status: 'running' });
    return true;
  }

  /**
   * 获取会话状态
   */
  getSessionState(sessionId: string): SessionState {
    return this.sessionStates.get(sessionId) || { status: 'idle' };
  }

  /**
   * 获取所有会话状态
   */
  getAllStates(): Map<string, SessionState> {
    return new Map(this.sessionStates);
  }

  /**
   * 获取等待队列
   */
  getWaitingQueue(): string[] {
    return [...this.waitingQueue];
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    running: number;
    queued: number;
    available: number;
    maxConcurrent: number;
  } {
    return {
      running: this.semaphore.inUse(),
      queued: this.waitingQueue.length,
      available: this.semaphore.available(),
      maxConcurrent: this.config.maxConcurrentTasks,
    };
  }

  /**
   * 清理会话资源
   *
   * 会话关闭时调用，释放相关资源。
   */
  cleanup(sessionId: string): void {
    this.cleanupSession(sessionId);
  }

  /**
   * 设置工作目录
   */
  setWorkingDirectory(sessionId: string, directory: string): void {
    const wrapper = this.activeOrchestrators.get(sessionId);
    if (wrapper) {
      wrapper.orchestrator.setWorkingDirectory(directory);
    }
  }

  /**
   * 设置会话上下文（消息历史）
   *
   * 用于恢复会话时加载历史消息，确保 Agent 能够继续之前的对话。
   *
   * @param sessionId - 会话 ID
   * @param messages - 历史消息数组
   */
  setSessionContext(sessionId: string, messages: Message[]): void {
    const wrapper = this.activeOrchestrators.get(sessionId);
    if (wrapper) {
      wrapper.orchestrator.setMessages(messages);
      logger.debug(`Session context set for ${sessionId}, ${messages.length} messages`);
    } else {
      // 如果 Orchestrator 还不存在，先创建再设置
      const newWrapper = this.getOrCreateOrchestrator(sessionId);
      newWrapper.orchestrator.setMessages(messages);
      logger.debug(`Created orchestrator and set context for ${sessionId}, ${messages.length} messages`);
    }
  }

  /**
   * 获取会话的 Orchestrator（如果存在）
   *
   * @param sessionId - 会话 ID（可选，不传则返回当前活跃会话的 orchestrator）
   * @returns Orchestrator 实例或 undefined
   */
  getOrchestrator(sessionId?: string): AgentOrchestrator | undefined {
    const id = sessionId || this.currentSessionId;
    if (!id) return undefined;
    return this.activeOrchestrators.get(id)?.orchestrator;
  }

  /**
   * 获取或创建当前会话的 Orchestrator（公开版本，供外部消费方使用）
   *
   * @param sessionId - 会话 ID（可选，不传则使用当前活跃会话）
   * @returns Orchestrator 实例或 undefined（如果未初始化或无活跃会话）
   */
  getOrCreateCurrentOrchestrator(sessionId?: string): AgentOrchestrator | undefined {
    const id = sessionId || this.currentSessionId;
    if (!id || !this.configService || !this.onAgentEvent) return undefined;
    return this.getOrCreateOrchestrator(id).orchestrator;
  }

  /**
   * 获取当前活跃会话 ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * 设置当前活跃会话 ID
   */
  setCurrentSessionId(id: string | null): void {
    this.currentSessionId = id;
  }

  /**
   * 处理权限响应
   */
  handlePermissionResponse(
    sessionId: string,
    requestId: string,
    response: 'allow' | 'allow_session' | 'deny'
  ): void {
    const wrapper = this.activeOrchestrators.get(sessionId);
    if (wrapper) {
      wrapper.orchestrator.handlePermissionResponse(requestId, response);
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TaskManagerConfig>): void {
    const newMaxConcurrent = config.maxConcurrentTasks;
    if (newMaxConcurrent && newMaxConcurrent !== this.config.maxConcurrentTasks) {
      // 需要重建信号量（只有在没有运行任务时才安全）
      if (this.semaphore.inUse() === 0) {
        this.semaphore = new Semaphore(newMaxConcurrent);
        logger.info(`Updated max concurrent tasks to ${newMaxConcurrent}`);
      } else {
        logger.warn('Cannot update max concurrent tasks while tasks are running');
      }
    }
    this.config = { ...this.config, ...config };
  }

  /**
   * 关闭 TaskManager
   *
   * 取消所有运行中和排队的任务。
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down TaskManager...');

    // 取消所有排队任务
    for (const sessionId of [...this.waitingQueue]) {
      await this.cancelTask(sessionId);
    }

    // 取消所有运行中任务
    for (const sessionId of this.activeOrchestrators.keys()) {
      await this.cancelTask(sessionId);
    }

    // 清理信号量等待
    this.semaphore.clearWaiting('TaskManager shutdown');

    logger.info('TaskManager shutdown complete');
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 执行任务
   */
  private async executeTask(
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    logger.info(`Executing task for session ${sessionId}`);

    // 更新状态
    this.updateSessionState(sessionId, {
      status: 'running',
      startTime: Date.now(),
    });
    this.emitEvent('task_started', sessionId);

    // 获取或创建 Orchestrator
    const wrapper = this.getOrCreateOrchestrator(sessionId);

    try {
      await wrapper.orchestrator.sendMessage(message, attachments, options, messageMetadata);

      if (this.cancellingSessions.has(sessionId)) {
        this.finishCancelledSession(sessionId, { clearMarker: true });
        return;
      }

      // 任务完成
      this.updateSessionState(sessionId, { status: 'idle' });
      this.emitEvent('task_completed', sessionId);
    } catch (error) {
      if (this.cancellingSessions.has(sessionId)) {
        this.finishCancelledSession(sessionId, { clearMarker: true });
        return;
      }

      logger.error(`Task error for session ${sessionId}:`, error);
      this.updateSessionState(sessionId, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.emitEvent('task_error', sessionId, { error });
    } finally {
      // 释放信号量
      this.semaphore.release();

      // 处理队列中的下一个任务
      this.processQueue();
    }
  }

  /**
   * 将任务加入队列
   */
  private async enqueueTask(
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    logger.info(`Enqueueing task for session ${sessionId}`);

    this.waitingQueue.push(sessionId);
    this.updateSessionState(sessionId, {
      status: 'queued',
      queuePosition: this.waitingQueue.length,
    });
    this.updateQueuePositions();
    this.emitEvent('queue_update', sessionId);

    // 设置队列超时
    const timeoutId = setTimeout(() => {
      logger.warn(`Queue timeout for session ${sessionId}`);
      this.removeFromQueue(sessionId);
      this.updateSessionState(sessionId, {
        status: 'error',
        error: 'Queue timeout',
      });
      this.emitEvent('task_error', sessionId, { error: 'Queue timeout' });
    }, this.config.queueTimeout);

    this.queueTimeouts.set(sessionId, timeoutId);

    // 等待信号量
    try {
      await this.semaphore.acquire();

      // 检查是否还在队列中（可能被取消了）
      if (!this.waitingQueue.includes(sessionId)) {
        this.semaphore.release();
        return;
      }

      // 从队列移除
      this.removeFromQueue(sessionId);

      // 执行任务
      await this.executeTask(sessionId, message, attachments, options, messageMetadata);
    } catch (error) {
      logger.error(`Failed to acquire semaphore for session ${sessionId}:`, error);
      this.removeFromQueue(sessionId);
      this.updateSessionState(sessionId, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 处理队列中的下一个任务
   */
  private processQueue(): void {
    // 队列处理在 enqueueTask 的 semaphore.acquire() 中自动完成
    // 这里只需要更新队列位置
    this.updateQueuePositions();
    this.emitEvent('queue_update', '');
  }

  /**
   * 从队列中移除
   */
  private removeFromQueue(sessionId: string): void {
    const index = this.waitingQueue.indexOf(sessionId);
    if (index !== -1) {
      this.waitingQueue.splice(index, 1);
    }

    // 清除超时
    const timeoutId = this.queueTimeouts.get(sessionId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.queueTimeouts.delete(sessionId);
    }

    this.updateQueuePositions();
  }

  /**
   * 更新队列位置
   */
  private updateQueuePositions(): void {
    for (let i = 0; i < this.waitingQueue.length; i++) {
      const sessionId = this.waitingQueue[i];
      const state = this.sessionStates.get(sessionId);
      if (state?.status === 'queued') {
        state.queuePosition = i + 1;
      }
    }
  }

  /**
   * 获取或创建 Orchestrator
   *
   * 每个会话有独立的 Orchestrator 实例，确保并行执行时的完全隔离：
   * - 独立的消息历史
   * - 独立的工具执行器
   * - 独立的权限管理
   */
  private getOrCreateOrchestrator(sessionId: string): OrchestratorWrapper {
    let wrapper = this.activeOrchestrators.get(sessionId);

    if (!wrapper) {
      logger.debug(`Creating new orchestrator for session ${sessionId}`);

      // 每个会话创建独立的 Orchestrator，确保完全隔离
      const orchestrator = new AgentOrchestrator({
        configService: this.configService!,
        planningService: this.planningService,
        onEvent: async (event: AgentEvent) => {
          // 1. Forward to renderer (via onAgentEvent callback)
          this.onAgentEvent!(sessionId, event);

          // 2. Persist messages via sessionManager
          await this.persistEventToSession(sessionId, event);
        },
        getHomeDir: () => app.getPath('home'),
        broadcastDAGEvent: (event) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && win.webContents) {
              try { win.webContents.send(DAG_CHANNELS.EVENT, event); } catch {}
            }
          }
        },
      });
      orchestrator.setSessionId(sessionId);

      wrapper = {
        orchestrator,
        sessionId,
        createdAt: Date.now(),
      };

      this.activeOrchestrators.set(sessionId, wrapper);
      logger.info(`Orchestrator created for session ${sessionId}, total active: ${this.activeOrchestrators.size}`);
    }

    return wrapper;
  }

  /**
   * Persist agent events to session storage (moved from createAgentRuntime.ts)
   * Handles message aggregation, tool call results, and desktop notifications.
   */
  private async persistEventToSession(sessionId: string, event: AgentEvent): Promise<void> {
    try {
      const { getSessionManager, notificationService } = await import('../services');

      const sessionManager = getSessionManager();

      // Aggregate assistant messages within a single turn
      if (event.type === 'message' && event.data?.role === 'assistant') {
        const message = event.data;

        let turnState = this.turnStateBySession.get(sessionId);
        if (!turnState) {
          turnState = { messageId: '', toolCalls: [], content: '' };
          this.turnStateBySession.set(sessionId, turnState);
        }

        if (message.toolCalls && message.toolCalls.length > 0) {
          turnState.toolCalls.push(...message.toolCalls);
        }

        if (message.content) {
          turnState.content = message.content;
        }

        if (!turnState.messageId) {
          turnState.messageId = message.id;
          if (!wasMessagePersistedByContextAssembly(message)) {
            await sessionManager.addMessageToSession(sessionId, {
              ...message,
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          }
        } else {
          await sessionManager.updateMessage(turnState.messageId, {
            toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
            content: turnState.content,
          });
        }
      }

      // Update tool call results
      if (event.type === 'tool_call_end' && event.data) {
        const turnState = this.turnStateBySession.get(sessionId);
        const toolCallId = event.data.toolCallId;

        if (turnState?.messageId) {
          const idx = turnState.toolCalls.findIndex((tc) => tc.id === toolCallId);
          if (idx !== -1) {
            turnState.toolCalls[idx] = { ...turnState.toolCalls[idx], result: event.data };
          }
          await sessionManager.updateMessage(turnState.messageId, {
            toolCalls: [...turnState.toolCalls],
          });
        }
      }

      // Reset turn state when turn ends or agent completes
      if (event.type === 'turn_end' || event.type === 'agent_complete' || event.type === 'agent_cancelled') {
        this.turnStateBySession.delete(sessionId);
      }

      // Send desktop notification on permission request (needs user input)
      if (event.type === 'permission_request' && event.data) {
        const req = event.data as { tool?: string; command?: string };
        notificationService.notifyNeedsInput({
          sessionId,
          title: '需要授权',
          body: req.tool ? `${req.tool}: ${req.command || '请求执行权限'}` : '请求执行权限',
        });
      }

      // Send desktop notification on task complete
      if (event.type === 'task_complete' && event.data) {
        const session = await sessionManager.getSession(sessionId);
        if (session) {
          notificationService.notifyTaskComplete({
            sessionId: session.id,
            sessionTitle: session.title,
            summary: event.data.summary,
            duration: event.data.duration,
            toolsUsed: event.data.toolsUsed || [],
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to persist event for session ${sessionId}`, error);
    }
  }

  /**
   * 检查是否可以启动新任务
   *
   * @param sessionId - 会话 ID
   * @returns 可启动返回 true，否则返回 false 和原因
   */
  canStartTask(sessionId: string): { canStart: boolean; reason?: string } {
    const state = this.sessionStates.get(sessionId);

    if (state?.status === 'running' || state?.status === 'paused') {
      return { canStart: false, reason: 'Session already has a running task' };
    }

    if (state?.status === 'queued') {
      return { canStart: false, reason: 'Session is already queued' };
    }

    if (state?.status === 'cancelling') {
      return { canStart: false, reason: 'Session is being cancelled' };
    }

    return { canStart: true };
  }

  /**
   * 清理会话资源
   */
  private cleanupSession(sessionId: string): void {
    logger.debug(`Cleaning up session ${sessionId}`);

    // 移除 orchestrator
    this.activeOrchestrators.delete(sessionId);

    // 从队列移除
    this.removeFromQueue(sessionId);

    // 清理 turn state，防止内存泄漏
    this.turnStateBySession.delete(sessionId);

    // 更新状态
    this.updateSessionState(sessionId, { status: 'idle' });
  }

  private finishCancelledSession(sessionId: string, options: { clearMarker: boolean }): void {
    this.cleanupSession(sessionId);
    if (!this.cancelledEventEmitted.has(sessionId)) {
      this.cancelledEventEmitted.add(sessionId);
      this.emitEvent('task_cancelled', sessionId);
    }
    if (options.clearMarker) {
      this.cancellingSessions.delete(sessionId);
      this.cancelledEventEmitted.delete(sessionId);
    }
  }

  /**
   * 更新会话状态
   */
  private updateSessionState(sessionId: string, state: Partial<SessionState>): void {
    const current = this.sessionStates.get(sessionId) || { status: 'idle' as const };
    const newState = { ...current, ...state };
    this.sessionStates.set(sessionId, newState);
    this.persistSessionState(sessionId, newState);
    this.emitEvent('state_change', sessionId, newState);
  }

  private persistSessionState(sessionId: string, state: SessionState): void {
    try {
      const db = getDatabase();
      if (!db.isReady) return;
      db.updateSession(sessionId, {
        status: state.status,
        updatedAt: Date.now(),
      });
    } catch (error) {
      logger.debug(`Failed to persist task state for session ${sessionId}`, error);
    }
  }

  /**
   * 发送事件
   */
  private emitEvent(type: TaskManagerEventType, sessionId: string, data?: unknown): void {
    const event: TaskManagerEvent = { type, sessionId, data };
    this.emit(type, event);
    this.emit('event', event); // 通用事件
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let taskManagerInstance: TaskManager | null = null;

/**
 * 获取 TaskManager 单例
 */
export function getTaskManager(): TaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new TaskManager();
  }
  return taskManagerInstance;
}

/**
 * 初始化 TaskManager（带配置）
 */
export function initTaskManager(config?: Partial<TaskManagerConfig>): TaskManager {
  taskManagerInstance = new TaskManager(config);
  return taskManagerInstance;
}

/**
 * 重置 TaskManager（仅用于测试）
 */
export function resetTaskManager(): void {
  if (taskManagerInstance) {
    taskManagerInstance.shutdown().catch(() => {});
    taskManagerInstance = null;
  }
}
