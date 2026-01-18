// ============================================================================
// useCloudTasks - 云端任务状态管理 Hook
// 提供云端任务的查询、操作和实时更新
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  CloudTask,
  CreateCloudTaskRequest,
  CloudTaskFilter,
  TaskProgressEvent,
  CloudTaskStatus,
  TaskSyncState,
  CloudExecutionStats,
} from '@shared/types/cloud';

// ============================================================================
// 类型定义
// ============================================================================

interface UseCloudTasksOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
  filter?: CloudTaskFilter;
}

interface UseCloudTasksReturn {
  // 数据
  tasks: CloudTask[];
  isLoading: boolean;
  error: string | null;
  syncState: TaskSyncState | null;
  stats: CloudExecutionStats | null;

  // 操作
  createTask: (request: CreateCloudTaskRequest) => Promise<CloudTask | null>;
  startTask: (taskId: string) => Promise<boolean>;
  pauseTask: (taskId: string) => Promise<boolean>;
  cancelTask: (taskId: string) => Promise<boolean>;
  retryTask: (taskId: string) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<boolean>;
  refresh: () => Promise<void>;

  // 过滤
  setFilter: (filter: CloudTaskFilter) => void;
}

// ============================================================================
// IPC 通道（与主进程通信）
// ============================================================================

const CloudTaskChannels = {
  CREATE_TASK: 'cloud:task:create',
  UPDATE_TASK: 'cloud:task:update',
  CANCEL_TASK: 'cloud:task:cancel',
  GET_TASK: 'cloud:task:get',
  LIST_TASKS: 'cloud:task:list',
  DELETE_TASK: 'cloud:task:delete',
  START_TASK: 'cloud:task:start',
  PAUSE_TASK: 'cloud:task:pause',
  RESUME_TASK: 'cloud:task:resume',
  RETRY_TASK: 'cloud:task:retry',
  SYNC_TASKS: 'cloud:task:sync',
  GET_SYNC_STATE: 'cloud:task:syncState',
  TASK_PROGRESS: 'cloud:task:progress',
  TASK_COMPLETED: 'cloud:task:completed',
  TASK_FAILED: 'cloud:task:failed',
  GET_STATS: 'cloud:task:stats',
} as const;

// ============================================================================
// Hook 实现
// ============================================================================

export function useCloudTasks(options: UseCloudTasksOptions = {}): UseCloudTasksReturn {
  const {
    autoRefresh = true,
    refreshInterval = 5000,
    filter: initialFilter = {},
  } = options;

  // 状态
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<TaskSyncState | null>(null);
  const [stats, setStats] = useState<CloudExecutionStats | null>(null);
  const [filter, setFilter] = useState<CloudTaskFilter>(initialFilter);

  // Refs
  const refreshTimerRef = useRef<NodeJS.Timer | null>(null);
  const isMountedRef = useRef(true);

  // --------------------------------------------------------------------------
  // IPC 调用辅助函数
  // --------------------------------------------------------------------------

  const invoke = useCallback(async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    // @ts-ignore - window.electronAPI 由 preload 注入
    if (typeof window !== 'undefined' && window.electronAPI?.invoke) {
      return window.electronAPI.invoke(channel, ...args);
    }

    // 模拟模式（用于开发/测试）
    console.warn(`[useCloudTasks] IPC not available, channel: ${channel}`);
    throw new Error('IPC not available');
  }, []);

  // --------------------------------------------------------------------------
  // 数据加载
  // --------------------------------------------------------------------------

  const loadTasks = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      setIsLoading(true);
      setError(null);

      const result = await invoke<CloudTask[]>(CloudTaskChannels.LIST_TASKS, filter);

      if (isMountedRef.current) {
        setTasks(result || []);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
        // 使用模拟数据
        setTasks([]);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [filter, invoke]);

  const loadSyncState = useCallback(async () => {
    try {
      const result = await invoke<TaskSyncState>(CloudTaskChannels.GET_SYNC_STATE);
      if (isMountedRef.current) {
        setSyncState(result);
      }
    } catch {
      // 忽略同步状态错误
    }
  }, [invoke]);

  const loadStats = useCallback(async () => {
    try {
      const result = await invoke<CloudExecutionStats>(CloudTaskChannels.GET_STATS);
      if (isMountedRef.current) {
        setStats(result);
      }
    } catch {
      // 忽略统计错误
    }
  }, [invoke]);

  // --------------------------------------------------------------------------
  // 任务操作
  // --------------------------------------------------------------------------

  const createTask = useCallback(async (request: CreateCloudTaskRequest): Promise<CloudTask | null> => {
    try {
      setError(null);
      const task = await invoke<CloudTask>(CloudTaskChannels.CREATE_TASK, request);

      if (task) {
        setTasks((prev) => [task, ...prev]);
        return task;
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
      return null;
    }
  }, [invoke]);

  const startTask = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const success = await invoke<boolean>(CloudTaskChannels.START_TASK, taskId);
      if (success) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status: 'queued' as CloudTaskStatus } : t
          )
        );
      }
      return success;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start task');
      return false;
    }
  }, [invoke]);

  const pauseTask = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const success = await invoke<boolean>(CloudTaskChannels.PAUSE_TASK, taskId);
      if (success) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status: 'paused' as CloudTaskStatus } : t
          )
        );
      }
      return success;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pause task');
      return false;
    }
  }, [invoke]);

  const cancelTask = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const success = await invoke<boolean>(CloudTaskChannels.CANCEL_TASK, taskId);
      if (success) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status: 'cancelled' as CloudTaskStatus } : t
          )
        );
      }
      return success;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel task');
      return false;
    }
  }, [invoke]);

  const retryTask = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const success = await invoke<boolean>(CloudTaskChannels.RETRY_TASK, taskId);
      if (success) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, status: 'pending' as CloudTaskStatus, progress: 0, error: undefined }
              : t
          )
        );
      }
      return success;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry task');
      return false;
    }
  }, [invoke]);

  const deleteTask = useCallback(async (taskId: string): Promise<boolean> => {
    try {
      const success = await invoke<boolean>(CloudTaskChannels.DELETE_TASK, taskId);
      if (success) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
      }
      return success;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
      return false;
    }
  }, [invoke]);

  const refresh = useCallback(async () => {
    await Promise.all([loadTasks(), loadSyncState(), loadStats()]);
  }, [loadTasks, loadSyncState, loadStats]);

  // --------------------------------------------------------------------------
  // 事件监听
  // --------------------------------------------------------------------------

  useEffect(() => {
    // @ts-ignore
    if (typeof window !== 'undefined' && window.electronAPI?.on) {
      // 监听任务进度更新
      const unsubProgress = window.electronAPI.on(
        CloudTaskChannels.TASK_PROGRESS,
        (event: TaskProgressEvent) => {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === event.taskId
                ? {
                    ...t,
                    status: event.status,
                    progress: event.progress,
                    currentStep: event.currentStep,
                  }
                : t
            )
          );
        }
      );

      // 监听任务完成
      const unsubCompleted = window.electronAPI.on(
        CloudTaskChannels.TASK_COMPLETED,
        (task: CloudTask) => {
          setTasks((prev) =>
            prev.map((t) => (t.id === task.id ? task : t))
          );
        }
      );

      // 监听任务失败
      const unsubFailed = window.electronAPI.on(
        CloudTaskChannels.TASK_FAILED,
        (task: CloudTask) => {
          setTasks((prev) =>
            prev.map((t) => (t.id === task.id ? task : t))
          );
        }
      );

      return () => {
        unsubProgress?.();
        unsubCompleted?.();
        unsubFailed?.();
      };
    }
  }, []);

  // --------------------------------------------------------------------------
  // 自动刷新
  // --------------------------------------------------------------------------

  useEffect(() => {
    // 初始加载
    loadTasks();
    loadSyncState();
    loadStats();

    // 设置自动刷新
    if (autoRefresh && refreshInterval > 0) {
      refreshTimerRef.current = setInterval(() => {
        loadTasks();
        loadSyncState();
      }, refreshInterval);
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [autoRefresh, refreshInterval, loadTasks, loadSyncState, loadStats]);

  // 组件卸载标记
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 过滤器变化时重新加载
  useEffect(() => {
    loadTasks();
  }, [filter, loadTasks]);

  // --------------------------------------------------------------------------
  // 返回值
  // --------------------------------------------------------------------------

  return {
    tasks,
    isLoading,
    error,
    syncState,
    stats,
    createTask,
    startTask,
    pauseTask,
    cancelTask,
    retryTask,
    deleteTask,
    refresh,
    setFilter,
  };
}

// ============================================================================
// 辅助 Hooks
// ============================================================================

/**
 * 获取单个任务详情
 */
export function useCloudTask(taskId: string | null) {
  const [task, setTask] = useState<CloudTask | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      return;
    }

    const loadTask = async () => {
      setIsLoading(true);
      try {
        // @ts-ignore
        if (window.electronAPI?.invoke) {
          const result = await window.electronAPI.invoke(
            CloudTaskChannels.GET_TASK,
            taskId
          );
          setTask(result);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load task');
      } finally {
        setIsLoading(false);
      }
    };

    loadTask();
  }, [taskId]);

  return { task, isLoading, error };
}

/**
 * 获取任务统计信息
 */
export function useCloudTaskStats() {
  const [stats, setStats] = useState<CloudExecutionStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      try {
        // @ts-ignore
        if (window.electronAPI?.invoke) {
          const result = await window.electronAPI.invoke(CloudTaskChannels.GET_STATS);
          setStats(result);
        }
      } catch {
        // 忽略错误
      } finally {
        setIsLoading(false);
      }
    };

    loadStats();
    const timer = setInterval(loadStats, 30000); // 30 秒刷新一次

    return () => clearInterval(timer);
  }, []);

  return { stats, isLoading };
}
