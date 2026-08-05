import type { TaskManager } from '../../task/TaskManager';

export async function getVoiceTaskManager(): Promise<TaskManager> {
  const { getTaskManager } = await import('../../task');
  return getTaskManager();
}

export async function cancelVoiceManagedTask(
  taskManager: TaskManager,
  sessionId: string,
  workItemId: string,
): Promise<boolean> {
  if (typeof taskManager.cancelBackgroundTask === 'function') {
    return taskManager.cancelBackgroundTask(workItemId);
  }
  await taskManager.cancelTask(sessionId);
  return true;
}
