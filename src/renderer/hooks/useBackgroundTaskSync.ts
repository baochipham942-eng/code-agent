import { useEffect } from 'react';
import type { TaskNotification } from '@shared/contract/backgroundTask';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useSessionStore } from '../stores/sessionStore';
import { toast } from './useToast';

interface UseBackgroundTaskSyncOptions {
  enabled?: boolean;
  pollInterval?: number;
}

const DEFAULT_POLL_INTERVAL = 3000;

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

    void sync();
    if (pollInterval <= 0) return;

    const timer = setInterval(() => {
      void sync();
    }, pollInterval);

    return () => clearInterval(timer);
  }, [currentSessionId, drainNotifications, enabled, pollInterval, refreshTasks]);
}
