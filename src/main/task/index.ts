// ============================================================================
// Task Module - 多任务并行支持
// Wave 5: OpenWork + AionUi 迁移
// ============================================================================

export {
  TaskManager,
  getTaskManager,
  initTaskManager,
  resetTaskManager,
  type SessionStatus,
  type SessionState,
  type TaskManagerConfig,
  type TaskManagerEvent,
  type TaskManagerEventType,
} from './TaskManager';

export { Semaphore } from './Semaphore';
