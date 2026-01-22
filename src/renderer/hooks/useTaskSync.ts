// ============================================================================
// useTaskSync - Task State Real-time Sync Hook
// Wave 5: Multi-task parallel support
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTaskStore, type SessionState, type TaskStats } from '../stores/taskStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('useTaskSync');

// ============================================================================
// Types
// ============================================================================

export interface UseTaskSyncOptions {
  /** Whether to enable automatic sync, default true */
  enabled?: boolean;
  /** Polling interval in milliseconds, default 5000 */
  pollInterval?: number;
}

export interface UseTaskSyncReturn {
  /** Manually refresh state */
  refresh: () => Promise<void>;
  /** Whether sync is in progress */
  isSyncing: boolean;
  /** Last sync timestamp */
  lastSyncTime: number | null;
}

// IPC event types for task state changes
interface TaskStateChangedEvent {
  type: 'state_change';
  sessionId: string;
  data: SessionState;
}

interface TaskStatsUpdatedEvent {
  type: 'stats_updated';
  data: TaskStats;
}

interface TaskQueueUpdateEvent {
  type: 'queue_update';
  sessionId: string;
  queue: string[];
}

type TaskEvent = TaskStateChangedEvent | TaskStatsUpdatedEvent | TaskQueueUpdateEvent;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL = 5000;
const IPC_TASK_EVENT = 'task:event' as const;

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * useTaskSync - Task state real-time sync hook
 *
 * Listens for IPC events and updates taskStore.
 * Supports periodic polling as a backup sync mechanism.
 *
 * @example
 * ```typescript
 * const { refresh, isSyncing, lastSyncTime } = useTaskSync({
 *   enabled: true,
 *   pollInterval: 3000,
 * });
 *
 * // Manually refresh
 * await refresh();
 * ```
 */
export function useTaskSync(options: UseTaskSyncOptions = {}): UseTaskSyncReturn {
  const { enabled = true, pollInterval = DEFAULT_POLL_INTERVAL } = options;

  // State
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);

  // Refs for cleanup
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  // Store actions
  const { refreshStates, refreshStats, updateSessionState, updateStats } = useTaskStore();

  // --------------------------------------------------------------------------
  // Core Sync Logic
  // --------------------------------------------------------------------------

  /**
   * Perform full sync from main process
   */
  const performSync = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (!window.domainAPI) {
      logger.warn('domainAPI not available, skipping sync');
      return;
    }

    try {
      setIsSyncing(true);

      // Fetch all states and stats in parallel
      await Promise.all([refreshStates(), refreshStats()]);

      if (isMountedRef.current) {
        setLastSyncTime(Date.now());
      }
    } catch (error) {
      logger.error('Failed to sync task states:', error);
    } finally {
      if (isMountedRef.current) {
        setIsSyncing(false);
      }
    }
  }, [refreshStates, refreshStats]);

  /**
   * Manual refresh function exposed to consumers
   */
  const refresh = useCallback(async () => {
    await performSync();
  }, [performSync]);

  // --------------------------------------------------------------------------
  // IPC Event Handlers
  // --------------------------------------------------------------------------

  /**
   * Handle task state change event
   */
  const handleTaskStateChange = useCallback(
    (event: TaskStateChangedEvent) => {
      if (!isMountedRef.current) return;
      logger.debug(`Task state changed: ${event.sessionId}`, { state: event.data });
      updateSessionState(event.sessionId, event.data);
      setLastSyncTime(Date.now());
    },
    [updateSessionState]
  );

  /**
   * Handle stats update event
   */
  const handleStatsUpdate = useCallback(
    (event: TaskStatsUpdatedEvent) => {
      if (!isMountedRef.current) return;
      logger.debug('Task stats updated', { stats: event.data });
      updateStats(event.data);
      setLastSyncTime(Date.now());
    },
    [updateStats]
  );

  /**
   * Handle queue update event
   */
  const handleQueueUpdate = useCallback(
    (_event: TaskQueueUpdateEvent) => {
      if (!isMountedRef.current) return;
      logger.debug('Task queue updated');
      // Queue changes need full refresh to update positions
      refreshStates();
      setLastSyncTime(Date.now());
    },
    [refreshStates]
  );

  /**
   * Unified event handler
   */
  const handleTaskEvent = useCallback(
    (event: TaskEvent) => {
      switch (event.type) {
        case 'state_change':
          handleTaskStateChange(event as TaskStateChangedEvent);
          break;
        case 'stats_updated':
          handleStatsUpdate(event as TaskStatsUpdatedEvent);
          break;
        case 'queue_update':
          handleQueueUpdate(event as TaskQueueUpdateEvent);
          break;
        default:
          logger.warn('Unknown task event type:', { type: (event as { type: string }).type });
      }
    },
    [handleTaskStateChange, handleStatsUpdate, handleQueueUpdate]
  );

  // --------------------------------------------------------------------------
  // Effects
  // --------------------------------------------------------------------------

  /**
   * Register IPC event listeners
   */
  useEffect(() => {
    if (!enabled) return;

    // Try to register IPC event listener if available
    if (window.electronAPI?.on) {
      logger.debug('Registering task event listener');

      // Note: The IPC event channel may not exist yet
      // We attempt to listen, but fall back to polling if events aren't received
      try {
        const unsubscribe = window.electronAPI.on(
          IPC_TASK_EVENT as keyof import('@shared/ipc').IpcEventHandlers,
          handleTaskEvent as never
        );

        return () => {
          logger.debug('Unregistering task event listener');
          unsubscribe?.();
        };
      } catch (error) {
        logger.warn('Failed to register task event listener, relying on polling:', { error });
      }
    }
  }, [enabled, handleTaskEvent]);

  /**
   * Initial sync and polling setup
   */
  useEffect(() => {
    if (!enabled) return;

    // Perform initial sync
    performSync();

    // Set up polling as backup/fallback mechanism
    if (pollInterval > 0) {
      logger.debug(`Setting up task sync polling with interval: ${pollInterval}ms`);

      pollTimerRef.current = setInterval(() => {
        if (isMountedRef.current) {
          performSync();
        }
      }, pollInterval);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled, pollInterval, performSync]);

  /**
   * Track mount state
   */
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // --------------------------------------------------------------------------
  // Return Value
  // --------------------------------------------------------------------------

  return {
    refresh,
    isSyncing,
    lastSyncTime,
  };
}

// ============================================================================
// Utility Hooks
// ============================================================================

/**
 * Hook to get a specific session's sync status
 */
export function useSessionTaskState(sessionId: string | null) {
  const { getSessionState, sessionStates } = useTaskStore();

  if (!sessionId) {
    return { status: 'idle' as const, queuePosition: undefined };
  }

  // Subscribe to the specific session state
  const state = sessionStates[sessionId] || getSessionState(sessionId);
  return state;
}

/**
 * Hook to check if any task is running
 */
export function useHasRunningTasks(): boolean {
  const { stats } = useTaskStore();
  return stats.running > 0;
}

/**
 * Hook to get task concurrency info
 */
export function useTaskConcurrency() {
  const { stats } = useTaskStore();
  return {
    running: stats.running,
    queued: stats.queued,
    available: stats.available,
    maxConcurrent: stats.maxConcurrent,
    isFull: stats.available === 0,
    hasQueue: stats.queued > 0,
  };
}
