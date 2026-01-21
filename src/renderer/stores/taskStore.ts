// ============================================================================
// Task Store - 多任务状态管理
// Wave 5: OpenWork + AionUi 迁移
// ============================================================================

import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../utils/logger';

const logger = createLogger('TaskStore');

// ============================================================================
// Types
// ============================================================================

export type SessionStatus = 'idle' | 'running' | 'queued' | 'cancelling' | 'error';

export interface SessionState {
  status: SessionStatus;
  queuePosition?: number;
  startTime?: number;
  error?: string;
}

export interface TaskStats {
  running: number;
  queued: number;
  available: number;
  maxConcurrent: number;
}

interface TaskStoreState {
  // 会话状态映射
  sessionStates: Record<string, SessionState>;
  // 等待队列
  waitingQueue: string[];
  // 统计信息
  stats: TaskStats;
  // 是否已初始化
  initialized: boolean;
}

interface TaskStoreActions {
  // 刷新所有状态
  refreshStates: () => Promise<void>;
  // 刷新统计信息
  refreshStats: () => Promise<void>;
  // 获取单个会话状态
  getSessionState: (sessionId: string) => SessionState;
  // 启动任务
  startTask: (sessionId: string, message: string, attachments?: unknown[]) => Promise<void>;
  // 中断任务（软中断）
  interruptTask: (sessionId: string) => Promise<void>;
  // 取消任务（硬取消）
  cancelTask: (sessionId: string) => Promise<void>;
  // 清理会话
  cleanup: (sessionId: string) => Promise<void>;
  // 更新单个会话状态（从事件）
  updateSessionState: (sessionId: string, state: SessionState) => void;
  // 更新统计信息（从事件）
  updateStats: (stats: TaskStats) => void;
}

type TaskStore = TaskStoreState & TaskStoreActions;

// ============================================================================
// Store
// ============================================================================

export const useTaskStore = create<TaskStore>()((set, get) => ({
  // 初始状态
  sessionStates: {},
  waitingQueue: [],
  stats: {
    running: 0,
    queued: 0,
    available: 3,
    maxConcurrent: 3,
  },
  initialized: false,

  // 刷新所有状态
  refreshStates: async () => {
    if (!window.domainAPI) return;
    try {
      const response = await window.domainAPI.invoke<Record<string, SessionState>>(
        IPC_DOMAINS.TASK,
        'getAllStates'
      );
      if (response.success && response.data) {
        set({ sessionStates: response.data, initialized: true });
      }

      // 同时刷新队列
      const queueResponse = await window.domainAPI.invoke<string[]>(
        IPC_DOMAINS.TASK,
        'getQueue'
      );
      if (queueResponse.success && queueResponse.data) {
        set({ waitingQueue: queueResponse.data });
      }
    } catch (error) {
      logger.error('Failed to refresh states:', error);
    }
  },

  // 刷新统计信息
  refreshStats: async () => {
    if (!window.domainAPI) return;
    try {
      const response = await window.domainAPI.invoke<TaskStats>(
        IPC_DOMAINS.TASK,
        'getStats'
      );
      if (response.success && response.data) {
        set({ stats: response.data });
      }
    } catch (error) {
      logger.error('Failed to refresh stats:', error);
    }
  },

  // 获取单个会话状态
  getSessionState: (sessionId: string): SessionState => {
    const { sessionStates } = get();
    return sessionStates[sessionId] || { status: 'idle' };
  },

  // 启动任务
  startTask: async (sessionId: string, message: string, attachments?: unknown[]) => {
    if (!window.domainAPI) throw new Error('domainAPI not available');
    try {
      // 先更新本地状态为 queued（乐观更新）
      set((state) => ({
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { status: 'queued' },
        },
      }));

      const response = await window.domainAPI.invoke(
        IPC_DOMAINS.TASK,
        'start',
        { sessionId, message, attachments }
      );

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to start task');
      }

      // 刷新状态
      await get().refreshStates();
      await get().refreshStats();
    } catch (error) {
      logger.error('Failed to start task:', error);
      // 回滚状态
      set((state) => ({
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { status: 'error', error: String(error) },
        },
      }));
      throw error;
    }
  },

  // 中断任务
  interruptTask: async (sessionId: string) => {
    if (!window.domainAPI) throw new Error('domainAPI not available');
    try {
      set((state) => ({
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...state.sessionStates[sessionId], status: 'cancelling' },
        },
      }));

      const response = await window.domainAPI.invoke(
        IPC_DOMAINS.TASK,
        'interrupt',
        { sessionId }
      );

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to interrupt task');
      }

      await get().refreshStates();
      await get().refreshStats();
    } catch (error) {
      logger.error('Failed to interrupt task:', error);
      throw error;
    }
  },

  // 取消任务
  cancelTask: async (sessionId: string) => {
    if (!window.domainAPI) throw new Error('domainAPI not available');
    try {
      const response = await window.domainAPI.invoke(
        IPC_DOMAINS.TASK,
        'cancel',
        { sessionId }
      );

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to cancel task');
      }

      await get().refreshStates();
      await get().refreshStats();
    } catch (error) {
      logger.error('Failed to cancel task:', error);
      throw error;
    }
  },

  // 清理会话
  cleanup: async (sessionId: string) => {
    if (!window.domainAPI) throw new Error('domainAPI not available');
    try {
      const response = await window.domainAPI.invoke(
        IPC_DOMAINS.TASK,
        'cleanup',
        { sessionId }
      );

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to cleanup');
      }

      // 移除本地状态
      set((state) => {
        const { [sessionId]: _, ...rest } = state.sessionStates;
        return { sessionStates: rest };
      });
    } catch (error) {
      logger.error('Failed to cleanup:', error);
      throw error;
    }
  },

  // 更新单个会话状态（从事件）
  updateSessionState: (sessionId: string, state: SessionState) => {
    set((current) => ({
      sessionStates: {
        ...current.sessionStates,
        [sessionId]: state,
      },
    }));
  },

  // 更新统计信息（从事件）
  updateStats: (stats: TaskStats) => {
    set({ stats });
  },
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * 获取状态的显示标签
 */
export function getStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'idle':
      return '空闲';
    case 'running':
      return '运行中';
    case 'queued':
      return '排队中';
    case 'cancelling':
      return '取消中';
    case 'error':
      return '错误';
    default:
      return status;
  }
}

/**
 * 获取状态的颜色
 */
export function getStatusColor(status: SessionStatus): string {
  switch (status) {
    case 'idle':
      return 'text-gray-500';
    case 'running':
      return 'text-green-500';
    case 'queued':
      return 'text-yellow-500';
    case 'cancelling':
      return 'text-orange-500';
    case 'error':
      return 'text-red-500';
    default:
      return 'text-gray-500';
  }
}
