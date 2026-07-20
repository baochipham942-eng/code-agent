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
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  useEffect(() => {
    if (!enabled) return;

    const sync = async () => {
      await refreshTasks();
      if (!currentSessionId) return;
      const notifications = await drainNotifications(currentSessionId);
      notifications.forEach(showTaskNotification);
    };

    let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = ipcService.on('agent:event', (event: AgentEventEnvelope) => {
      if (event.type !== 'background_task_ledger_changed') return;
      if (invalidationTimer !== null) clearTimeout(invalidationTimer);
      invalidationTimer = setTimeout(() => {
        invalidationTimer = null;
        void sync().catch((error) => {
          logger.warn('Background task push sync failed', { error });
        });
      }, RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    let stopPoller: (() => void) | undefined;

    if (pollInterval <= 0) {
      void sync().catch((error) => {
        logger.warn('Initial background task sync failed', { error });
      });
    } else {
      // 推送负责及时刷新；轮询仅用于丢失推送后的追平。
      const poller = createBackoffPoller(sync, {
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
  }, [currentSessionId, drainNotifications, enabled, pollInterval, refreshTasks]);
}
