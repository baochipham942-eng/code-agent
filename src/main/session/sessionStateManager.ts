// ============================================================================
// Session State Manager - 会话运行时状态管理（支持多会话并行）
// ============================================================================

import { BrowserWindow } from 'electron';
import type { Message } from '../../shared/types';
import type { ContextHealthState } from '../../shared/types/contextHealth';
import { createEmptyHealthState } from '../../shared/types/contextHealth';
import type {
  SessionStatus,
  SubagentState,
  SessionStatusUpdateEvent,
  SessionRuntimeSummary,
} from '../../shared/types/sessionState';
import { IPC_CHANNELS } from '../../shared/ipc';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionStateManager');

// Re-export types for convenience
export type { SessionStatus, SubagentState, SessionStatusUpdateEvent, SessionRuntimeSummary };

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 会话运行时状态
 *
 * 每个会话独立维护自己的运行状态，支持多会话并行执行
 */
export interface SessionRuntimeState {
  /** 会话 ID */
  sessionId: string;
  /** 运行状态 */
  status: SessionStatus;
  /** 消息历史 */
  messages: Message[];
  /** 上下文健康状态 */
  contextHealth: ContextHealthState;
  /** 活跃的子代理 */
  activeSubagents: Map<string, SubagentState>;
  /** 创建时间 */
  createdAt: number;
  /** 最后活动时间 */
  lastActivityAt: number;
}

// ----------------------------------------------------------------------------
// Session State Manager
// ----------------------------------------------------------------------------

/**
 * 会话状态管理器
 *
 * 负责管理多个会话的运行时状态，支持：
 * - 多会话并行执行
 * - 状态隔离
 * - 实时状态更新
 */
export class SessionStateManager {
  private states: Map<string, SessionRuntimeState> = new Map();
  private mainWindow: BrowserWindow | null = null;

  /**
   * 设置主窗口用于发送事件
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * 获取或创建会话状态
   */
  getOrCreate(sessionId: string): SessionRuntimeState {
    let state = this.states.get(sessionId);

    if (!state) {
      state = this.createState(sessionId);
      this.states.set(sessionId, state);
      logger.debug(`Created runtime state for session: ${sessionId}`);
    }

    return state;
  }

  /**
   * 获取会话状态
   */
  get(sessionId: string): SessionRuntimeState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * 创建初始状态
   */
  private createState(sessionId: string): SessionRuntimeState {
    const now = Date.now();
    return {
      sessionId,
      status: 'idle',
      messages: [],
      contextHealth: createEmptyHealthState(),
      activeSubagents: new Map(),
      createdAt: now,
      lastActivityAt: now,
    };
  }

  /**
   * 更新会话状态
   */
  updateStatus(sessionId: string, status: SessionStatus): void {
    const state = this.getOrCreate(sessionId);
    const oldStatus = state.status;
    state.status = status;
    state.lastActivityAt = Date.now();

    if (oldStatus !== status) {
      logger.info(`Session ${sessionId} status: ${oldStatus} -> ${status}`);
      this.emitStatusUpdate(sessionId);
    }
  }

  /**
   * 更新消息历史
   */
  updateMessages(sessionId: string, messages: Message[]): void {
    const state = this.getOrCreate(sessionId);
    state.messages = messages;
    state.lastActivityAt = Date.now();
  }

  /**
   * 更新上下文健康状态
   */
  updateContextHealth(sessionId: string, health: ContextHealthState): void {
    const state = this.getOrCreate(sessionId);
    state.contextHealth = health;
    state.lastActivityAt = Date.now();
  }

  /**
   * 添加子代理
   */
  addSubagent(sessionId: string, subagent: SubagentState): void {
    const state = this.getOrCreate(sessionId);
    state.activeSubagents.set(subagent.id, subagent);
    state.lastActivityAt = Date.now();

    logger.debug(`Added subagent ${subagent.id} to session ${sessionId}`);
    this.emitStatusUpdate(sessionId);
  }

  /**
   * 更新子代理状态
   */
  updateSubagent(sessionId: string, subagentId: string, updates: Partial<SubagentState>): void {
    const state = this.get(sessionId);
    if (!state) return;

    const subagent = state.activeSubagents.get(subagentId);
    if (subagent) {
      Object.assign(subagent, updates);
      state.lastActivityAt = Date.now();
      this.emitStatusUpdate(sessionId);
    }
  }

  /**
   * 移除子代理
   */
  removeSubagent(sessionId: string, subagentId: string): void {
    const state = this.get(sessionId);
    if (!state) return;

    state.activeSubagents.delete(subagentId);
    state.lastActivityAt = Date.now();

    logger.debug(`Removed subagent ${subagentId} from session ${sessionId}`);
    this.emitStatusUpdate(sessionId);
  }

  /**
   * 清理会话状态
   */
  cleanup(sessionId: string): void {
    this.states.delete(sessionId);
    logger.debug(`Cleaned up runtime state for session: ${sessionId}`);
  }

  /**
   * 获取所有运行中的会话
   */
  getRunning(): SessionRuntimeState[] {
    return Array.from(this.states.values()).filter(
      (state) => state.status === 'running'
    );
  }

  /**
   * 检查是否有任何会话在运行
   */
  isAnyRunning(): boolean {
    return this.getRunning().length > 0;
  }

  /**
   * 获取会话的活跃代理数量
   */
  getActiveAgentCount(sessionId: string): number {
    const state = this.get(sessionId);
    if (!state) return 0;

    // 计算运行中的子代理
    let count = 0;
    for (const subagent of state.activeSubagents.values()) {
      if (subagent.status === 'running' || subagent.status === 'pending') {
        count++;
      }
    }

    // 如果会话本身在运行，至少有一个主代理
    if (state.status === 'running' && count === 0) {
      count = 1;
    }

    return count;
  }

  /**
   * 获取单个会话的摘要状态
   */
  getSummary(sessionId: string): SessionRuntimeSummary | null {
    const state = this.get(sessionId);
    if (!state) return null;

    return {
      sessionId,
      status: state.status,
      activeAgentCount: this.getActiveAgentCount(sessionId),
      contextHealth: state.contextHealth,
      lastActivityAt: state.lastActivityAt,
    };
  }

  /**
   * 获取所有会话的摘要状态（数组形式）
   */
  getAllSummariesArray(): SessionRuntimeSummary[] {
    const summaries: SessionRuntimeSummary[] = [];

    for (const [sessionId, state] of this.states) {
      summaries.push({
        sessionId,
        status: state.status,
        activeAgentCount: this.getActiveAgentCount(sessionId),
        contextHealth: state.contextHealth,
        lastActivityAt: state.lastActivityAt,
      });
    }

    return summaries;
  }

  /**
   * 获取所有会话的摘要状态（Map 形式）
   * @deprecated Use getAllSummariesArray instead
   */
  getAllSummaries(): Map<string, {
    status: SessionStatus;
    activeAgentCount: number;
    contextHealth: ContextHealthState | null;
  }> {
    const summaries = new Map();

    for (const [sessionId, state] of this.states) {
      summaries.set(sessionId, {
        status: state.status,
        activeAgentCount: this.getActiveAgentCount(sessionId),
        contextHealth: state.contextHealth,
      });
    }

    return summaries;
  }

  /**
   * 清理所有状态
   */
  clear(): void {
    this.states.clear();
    logger.info('All session runtime states cleared');
  }

  /**
   * 清理空闲超时的会话状态
   *
   * @param maxIdleTime - 最大空闲时间（毫秒）
   */
  cleanupIdleSessions(maxIdleTime: number = 30 * 60 * 1000): void {
    const now = Date.now();
    const toCleanup: string[] = [];

    for (const [sessionId, state] of this.states) {
      if (state.status === 'idle' && now - state.lastActivityAt > maxIdleTime) {
        toCleanup.push(sessionId);
      }
    }

    for (const sessionId of toCleanup) {
      this.cleanup(sessionId);
    }

    if (toCleanup.length > 0) {
      logger.info(`Cleaned up ${toCleanup.length} idle session states`);
    }
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 发送状态更新事件到渲染进程
   */
  private emitStatusUpdate(sessionId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const state = this.get(sessionId);
    if (!state) return;

    const event: SessionStatusUpdateEvent = {
      sessionId,
      status: state.status,
      activeAgentCount: this.getActiveAgentCount(sessionId),
      contextHealth: state.contextHealth,
    };

    try {
      this.mainWindow.webContents.send(IPC_CHANNELS.SESSION_STATUS_UPDATE, event);
    } catch (error) {
      logger.error('Failed to emit session status update:', error);
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let sessionStateManagerInstance: SessionStateManager | null = null;

/**
 * 获取 SessionStateManager 单例
 */
export function getSessionStateManager(): SessionStateManager {
  if (!sessionStateManagerInstance) {
    sessionStateManagerInstance = new SessionStateManager();
  }
  return sessionStateManagerInstance;
}

/**
 * 初始化 SessionStateManager
 */
export function initSessionStateManager(mainWindow: BrowserWindow): SessionStateManager {
  const manager = getSessionStateManager();
  manager.setMainWindow(mainWindow);

  // 定期清理空闲会话状态（每 10 分钟）
  setInterval(() => {
    manager.cleanupIdleSessions();
  }, 10 * 60 * 1000);

  logger.info('SessionStateManager initialized');
  return manager;
}
