import { useEffect } from 'react';
import type { TaskNotification } from '@shared/contract/backgroundTask';
import { RENDERER_POLLING } from '@shared/constants';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useSessionStore } from '../stores/sessionStore';
import { createBackoffPoller } from '../utils/backoffPoller';
import { createLogger } from '../utils/logger';
import { toast } from './useToast';

const logger = createLogger('useBackgroundTaskSync');

interface UseBackgroundTaskSyncOptions {
  enabled?: boolean;
  pollInterval?: number;
}

const DEFAULT_POLL_INTERVAL = RENDERER_POLLING.BACKGROUND_TASK_BASE;

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
    pollInterval = DEFAULT_POLL_INTERVAL,
  } = options;
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

    if (pollInterval <= 0) {
      void sync();
      return;
    }

    // 用退避轮询器：后端不可达时间隔从 base 翻倍到 MAX_BACKOFF，且失败日志节流
    const poller = createBackoffPoller(sync, {
      baseInterval: pollInterval,
      maxInterval: RENDERER_POLLING.MAX_BACKOFF,
      factor: RENDERER_POLLING.BACKOFF_FACTOR,
      onError: (error) => logger.warn('Background task sync failing, backing off', { error }),
      onRecover: () => logger.info('Background task sync recovered'),
    });
    poller.start();

    return () => poller.stop();
  }, [currentSessionId, drainNotifications, enabled, pollInterval, refreshTasks]);
}
