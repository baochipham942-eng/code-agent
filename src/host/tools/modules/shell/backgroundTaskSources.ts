import {
  getAllBackgroundTasks,
  getBackgroundTask,
  onBackgroundTaskLifecycleEvent,
  type BackgroundTaskLifecycleEvent,
  type TaskInfo,
} from '../../shell/backgroundTasks';
import {
  getAllPtySessions,
  onPtySessionLifecycleEvent,
  type PtySessionInfo,
  type PtySessionLifecycleEvent,
} from '../../shell/ptyExecutor';

export {
  getAllBackgroundTasks,
  getAllPtySessions,
  onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent,
};

export function getBackgroundTaskPid(taskId: string): number | undefined {
  return getBackgroundTask(taskId)?.process.pid;
}

export type {
  BackgroundTaskLifecycleEvent,
  PtySessionInfo,
  PtySessionLifecycleEvent,
  TaskInfo,
};
