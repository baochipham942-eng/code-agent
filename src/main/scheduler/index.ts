// ============================================================================
// Scheduler Module - Task DAG and Parallel Scheduling
// Session 4: Task DAG + Parallel Scheduling
// ============================================================================

// Core DAG
export { TaskDAG } from './TaskDAG';

// Scheduler
export {
  DAGScheduler,
  getDAGScheduler,
  initDAGScheduler,
  resetDAGScheduler,
  type DAGSchedulerConfig,
  type SchedulerContext,
  type SchedulerResult,
  type TaskExecutor,
} from './DAGScheduler';

// Event Bridge (DAG events → Renderer)
export { initDAGEventBridge, sendDAGInitEvent } from './dagEventBridge';

// Re-export types from shared
export type {
  DAGTask,
  DAGTaskType,
  TaskStatus,
  TaskPriority,
  TaskConfig,
  TaskMetadata,
  TaskOutput,
  TaskFailure,
  TaskExecutionContext,
  TaskDAGDefinition,
  TaskDAGState,
  DAGStatus,
  DAGStatistics,
  DAGOptions,
  DAGEvent,
  DAGEventType,
  AgentTaskConfig,
  ShellTaskConfig,
  WorkflowTaskConfig,
  FunctionTaskConfig,
  ParallelTaskConfig,
  ConditionalTaskConfig,
  CheckpointTaskConfig,
} from '../../shared/types/taskDAG';

export {
  DEFAULT_DAG_OPTIONS,
  createDefaultMetadata,
  createEmptyOutput,
  isTaskTerminal,
  isTaskExecutable,
  getNextTaskStatus,
  getPriorityValue,
} from '../../shared/types/taskDAG';
