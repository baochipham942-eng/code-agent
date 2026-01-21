// ============================================================================
// TaskManager - Multi-session task orchestration
// Wave 5: 多任务并行支持
// ============================================================================

import { EventEmitter } from 'events';
import type { AgentEvent } from '../../shared/types';
import { AgentOrchestrator, type AgentOrchestratorConfig } from '../agent/agentOrchestrator';
import type { GenerationManager } from '../generation/generationManager';
import type { ConfigService } from '../services/core/configService';
import type { PlanningService } from '../planning';
import { Semaphore } from './Semaphore';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TaskManager');

// ============================================================================
// Types
// ============================================================================

/**
 * 会话运行状态
 */
export type SessionStatus = 'idle' | 'running' | 'queued' | 'cancelling' | 'error';

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

  // 依赖注入
  private generationManager: GenerationManager | null = null;
  private configService: ConfigService | null = null;
  private planningService: PlanningService | undefined;
  private onAgentEvent: ((sessionId: string, event: AgentEvent) => void) | null = null;

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
    generationManager: GenerationManager;
    configService: ConfigService;
    planningService?: PlanningService;
    onAgentEvent: (sessionId: string, event: AgentEvent) => void;
  }): void {
    this.generationManager = deps.generationManager;
    this.configService = deps.configService;
    this.planningService = deps.planningService;
    this.onAgentEvent = deps.onAgentEvent;
    logger.info('TaskManager dependencies initialized');
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
    attachments?: unknown[]
  ): Promise<void> {
    if (!this.generationManager || !this.configService || !this.onAgentEvent) {
      throw new Error('TaskManager not initialized. Call initialize() first.');
    }

    // 检查是否已经在运行或排队
    const currentState = this.sessionStates.get(sessionId);
    if (currentState?.status === 'running' || currentState?.status === 'queued') {
      logger.warn(`Session ${sessionId} is already ${currentState.status}`);
      throw new Error(`Session ${sessionId} is already ${currentState.status}`);
    }

    // 尝试获取信号量
    if (this.semaphore.tryAcquire()) {
      // 立即执行
      await this.executeTask(sessionId, message, attachments);
    } else {
      // 加入队列
      await this.enqueueTask(sessionId, message, attachments);
    }
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
    if (!state || state.status !== 'running') {
      logger.warn(`Cannot interrupt session ${sessionId}: not running`);
      return;
    }

    logger.info(`Interrupting session ${sessionId} (soft interrupt)`);
    this.updateSessionState(sessionId, { status: 'cancelling' });

    const wrapper = this.activeOrchestrators.get(sessionId);
    if (!wrapper) {
      logger.warn(`No orchestrator found for session ${sessionId}`);
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

    // 清理资源
    this.cleanupSession(sessionId);
    this.emitEvent('task_cancelled', sessionId);
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

    if (state.status === 'running' || state.status === 'cancelling') {
      logger.info(`Cancelling session ${sessionId} (hard cancel)`);

      const wrapper = this.activeOrchestrators.get(sessionId);
      if (wrapper) {
        await wrapper.orchestrator.cancel();
      }

      this.cleanupSession(sessionId);
      this.emitEvent('task_cancelled', sessionId);
    }
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
    attachments?: unknown[]
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
      await wrapper.orchestrator.sendMessage(message, attachments);

      // 任务完成
      this.updateSessionState(sessionId, { status: 'idle' });
      this.emitEvent('task_completed', sessionId);
    } catch (error) {
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
    attachments?: unknown[]
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
      await this.executeTask(sessionId, message, attachments);
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
      if (state && state.status === 'queued') {
        state.queuePosition = i + 1;
      }
    }
  }

  /**
   * 获取或创建 Orchestrator
   */
  private getOrCreateOrchestrator(sessionId: string): OrchestratorWrapper {
    let wrapper = this.activeOrchestrators.get(sessionId);

    if (!wrapper) {
      logger.debug(`Creating new orchestrator for session ${sessionId}`);

      const orchestrator = new AgentOrchestrator({
        generationManager: this.generationManager!,
        configService: this.configService!,
        planningService: this.planningService,
        onEvent: (event: AgentEvent) => {
          this.onAgentEvent!(sessionId, event);
        },
      });

      wrapper = {
        orchestrator,
        sessionId,
        createdAt: Date.now(),
      };

      this.activeOrchestrators.set(sessionId, wrapper);
    }

    return wrapper;
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

    // 更新状态
    this.updateSessionState(sessionId, { status: 'idle' });
  }

  /**
   * 更新会话状态
   */
  private updateSessionState(sessionId: string, state: Partial<SessionState>): void {
    const current = this.sessionStates.get(sessionId) || { status: 'idle' as const };
    const newState = { ...current, ...state };
    this.sessionStates.set(sessionId, newState);
    this.emitEvent('state_change', sessionId, newState);
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
