import {
  getAllBackgroundTasks,
  getBackgroundTask,
} from '../../shell/backgroundTasks';

export { getAllBackgroundTasks };

export function getBackgroundTaskPid(taskId: string): number | undefined {
  return getBackgroundTask(taskId)?.process.pid;
}
