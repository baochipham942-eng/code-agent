// ============================================================================
// Task Execution Types - Event, Builder, and Helper types for Task DAG
// Split from taskDAG.ts for maintainability
// ============================================================================

import type {
  TaskStatus,
  TaskPriority,
  TaskOutput,
  TaskMetadata,
} from './taskDAG';

// ============================================================================
// Event Types
// ============================================================================

/**
 * DAG 事件类型
 */
export type DAGEventType =
  | 'dag:start'
  | 'dag:complete'
  | 'dag:failed'
  | 'dag:cancelled'
  | 'dag:paused'
  | 'dag:resumed'
  | 'task:ready'
  | 'task:start'
  | 'task:complete'
  | 'task:failed'
  | 'task:retry'
  | 'task:cancelled'
  | 'task:skipped'
  | 'progress:update';

/**
 * DAG 事件
 */
export interface DAGEvent {
  type: DAGEventType;
  dagId: string;
  taskId?: string;
  timestamp: number;
  data?: unknown;
}

// ============================================================================
// Builder Types (Fluent API)
// ============================================================================

/**
 * 任务构建器输入
 */
export interface TaskBuilderInput {
  id: string;
  name?: string;
  description?: string;
  priority?: TaskPriority;
  timeout?: number;
  allowFailure?: boolean;
}

/**
 * Agent 任务构建器输入
 */
export interface AgentTaskBuilderInput extends TaskBuilderInput {
  role: string;
  prompt: string;
  systemPrompt?: string;
  tools?: string[];
  maxIterations?: number;
  maxBudget?: number;
}

/**
 * Shell 任务构建器输入
 */
export interface ShellTaskBuilderInput extends TaskBuilderInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 创建默认任务元数据
 */
export function createDefaultMetadata(): TaskMetadata {
  return {
    createdAt: Date.now(),
    retryCount: 0,
    maxRetries: 0,
  };
}

/**
 * 创建空的任务输出
 */
export function createEmptyOutput(): TaskOutput {
  return {
    text: '',
    toolsUsed: [],
  };
}

/**
 * 检查任务是否为终态
 */
export function isTaskTerminal(status: TaskStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'skipped'].includes(status);
}

/**
 * 检查任务是否可执行
 */
export function isTaskExecutable(status: TaskStatus): boolean {
  return status === 'ready';
}

/**
 * 计算任务的下一个状态
 */
export function getNextTaskStatus(
  currentStatus: TaskStatus,
  event: 'dependencies_met' | 'start' | 'success' | 'failure' | 'cancel' | 'skip' | 'retry'
): TaskStatus {
  switch (event) {
    case 'dependencies_met':
      return currentStatus === 'pending' ? 'ready' : currentStatus;
    case 'start':
      return currentStatus === 'ready' ? 'running' : currentStatus;
    case 'success':
      return currentStatus === 'running' ? 'completed' : currentStatus;
    case 'failure':
      return currentStatus === 'running' ? 'failed' : currentStatus;
    case 'cancel':
      return ['pending', 'ready', 'running'].includes(currentStatus) ? 'cancelled' : currentStatus;
    case 'skip':
      return currentStatus === 'pending' ? 'skipped' : currentStatus;
    case 'retry':
      return currentStatus === 'failed' ? 'ready' : currentStatus;
    default:
      return currentStatus;
  }
}

/**
 * 计算优先级数值（用于排序）
 */
export function getPriorityValue(priority: TaskPriority): number {
  const values: Record<TaskPriority, number> = {
    low: 0,
    normal: 1,
    high: 2,
    critical: 3,
  };
  return values[priority];
}
