import {
  getAllBackgroundTasks,
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

export type {
  BackgroundTaskLifecycleEvent,
  PtySessionInfo,
  PtySessionLifecycleEvent,
  TaskInfo,
};
