import { useEffect } from 'react';
import type { AgentEventEnvelope } from '@shared/contract';
import type { TaskNotification } from '@shared/contract/backgroundTask';
import { RENDERER_POLLING } from '@shared/constants';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useSessionStore } from '../stores/sessionStore';
import ipcService from '../services/ipcService';
import { hasNativeBridge } from '../api/transport';
import { createBackoffPoller } from '../utils/backoffPoller';
import { createLogger } from '../utils/logger';
import { toast } from './useToast';

const logger = createLogger('useBackgroundTaskSync');

interface UseBackgroundTaskSyncOptions {
  enabled?: boolean;
  pollInterval?: number;
}

function showTaskNotification(notification: TaskNotification): void {
  const message = `${notification.message}。可在 TaskPanel 查看日志。`;
  if (notification.type === 'task_failed') {
    toast.error(message);
    return;
  }
  if (notification.type === 'task_completed') {
    toast.success(message);
    return;
  }
  if (notification.type === 'task_updated') {
    toast.info(message);
    return;
  }
  toast.warning(message);
}

export function useBackgroundTaskSync(options: UseBackgroundTaskSyncOptions = {}): void {
  const {
    enabled = true,
  } = options;
  const pollInterval = options.pollInterval ?? (
    hasNativeBridge()
      ? RENDERER_POLLING.BACKGROUND_TASK_FALLBACK
      : RENDERER_POLLING.BACKGROUND_TASK_BASE
  );
  const refreshTasks = useBackgroundTaskStore((state) => state.refreshTasks);
  const drainNotifications = useBackgroundTaskStore((state) => state.drainNotifications);
  const readRetryNonce = useBackgroundTaskStore((state) => state.readRetryNonce);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  useEffect(() => {
    if (!enabled) return;

    let statusReadBlocked = false;
    let stopPoller: (() => void) | undefined;

    const sync = async () => {
      if (statusReadBlocked) return;
      await refreshTasks();
      if (!currentSessionId) return;
      const notifications = await drainNotifications(currentSessionId);
      notifications.forEach(showTaskNotification);
    };

    const syncUntilReadFailure = async () => {
      try {
        await sync();
      } catch (error) {
        // A failed ledger read cannot prove that a task is still running.
        // Freeze the last known projection and wait for an explicit user retry.
        // 0 rows ≠ failure（C.11）：store 未置位 readFailure 说明手头无任务，
        // 轮询继续追平，不把空台账的一次读失败冻结成永久停摆。
        if (useBackgroundTaskStore.getState().readFailure) {
          statusReadBlocked = true;
          stopPoller?.();
        }
        throw error;
      }
    };

    let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = ipcService.on('agent:event', (event: AgentEventEnvelope) => {
      if (event.type !== 'background_task_ledger_changed') return;
      if (statusReadBlocked) return;
      if (invalidationTimer !== null) clearTimeout(invalidationTimer);
      invalidationTimer = setTimeout(() => {
        invalidationTimer = null;
        void syncUntilReadFailure().catch((error) => {
          logger.warn('Background task push sync failed', { error });
        });
      }, RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    if (pollInterval <= 0) {
      void syncUntilReadFailure().catch((error) => {
        logger.warn('Initial background task sync failed', { error });
      });
    } else {
      // 推送负责及时刷新；轮询仅用于丢失推送后的追平。
      const poller = createBackoffPoller(syncUntilReadFailure, {
        baseInterval: pollInterval,
        maxInterval: RENDERER_POLLING.MAX_BACKOFF,
        factor: RENDERER_POLLING.BACKOFF_FACTOR,
        onError: (error) => logger.warn('Background task sync failing, backing off', { error }),
        onRecover: () => logger.info('Background task sync recovered'),
      });
      poller.start();
      stopPoller = poller.stop;
    }

    return () => {
      unsubscribe?.();
      stopPoller?.();
      if (invalidationTimer !== null) clearTimeout(invalidationTimer);
    };
  }, [currentSessionId, drainNotifications, enabled, pollInterval, readRetryNonce, refreshTasks]);
}
