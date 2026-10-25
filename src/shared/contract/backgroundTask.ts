// ============================================================================
// Background Task Types - shared contract for main-side task ledgers
// ============================================================================

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'expired'
  | 'orphaned';

export type TaskSource = string;

export type TaskEventType = string;

export type TaskNotificationType =
  | 'task_created'
  | 'task_updated'
  | 'task_completed'
  | 'task_failed'
  | 'output_added'
  | 'custom';

export type TaskOutputRefType =
  | 'artifact'
  | 'file'
  | 'log'
  | 'report'
  | 'preview'
  | 'replay'
  | 'session'
  | 'url'
  | 'trace'
  | 'text'
  | 'other';

export type TaskMetadata = Record<string, unknown>;

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  status?: TaskStatus;
  message?: string;
  timestamp: number;
  data?: unknown;
  metadata?: TaskMetadata;
}

export interface TaskOutputRef {
  id: string;
  taskId: string;
  type: TaskOutputRefType;
  label?: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  createdAt: number;
  metadata?: TaskMetadata;
}

export interface TaskFailure {
  message: string;
  reason?: string;
  exitCode?: number;
  category?: string;
}

export interface LastToolStep {
  tool: string;
  toolIndex?: number;
  toolTotal?: number;
  target?: string;
  at: number;
}

/**
 * 终局工具失败（N-MEDIA-GEN-MUSIC-FALLBACK-FU1）：任务收尾后任务行要说清「为什么失败 + 出路」
 * 的那条结构化记录。host 只对准入码表里的 code 写入（见 SessionCommandCenter），
 * 同一工具后续成功即清除；渲染端仅在任务终态把它翻成人话。
 */
export interface LastToolFailure {
  tool: string;
  code: string;
  alternatives?: string;
  at: number;
}

export interface TaskProgress {
  current?: number;
  total?: number;
  percent?: number;
  label?: string;
  lastToolStep?: LastToolStep;
  lastToolFailure?: LastToolFailure;
}

export interface TaskNotification {
  id: string;
  taskId: string;
  sessionId: string;
  type: TaskNotificationType;
  title?: string;
  message: string;
  createdAt: number;
  deliveredAt?: number;
  payload?: unknown;
  metadata?: TaskMetadata;
}

export interface TaskLogReadResult {
  content: string;
  truncated: boolean;
  size: number;
}

export interface Task {
  id: string;
  kind?: string;
  sessionId?: string;
  parentTurnId?: string;
  toolCallId?: string;
  runId?: string;
  source: TaskSource;
  title: string;
  summary?: string;
  command?: string;
  cwd?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  progress?: TaskProgress;
  failure?: TaskFailure;
  metadata?: TaskMetadata;
  events: TaskEvent[];
  outputRefs: TaskOutputRef[];
}

export interface UpsertTaskInput {
  id: string;
  kind?: string;
  sessionId?: string;
  parentTurnId?: string;
  toolCallId?: string;
  runId?: string;
  source?: TaskSource;
  title?: string;
  summary?: string;
  command?: string;
  cwd?: string;
  status?: TaskStatus;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  progress?: TaskProgress;
  failure?: TaskFailure;
  metadata?: TaskMetadata;
}

export interface AppendTaskEventInput {
  id?: string;
  taskId: string;
  type: TaskEventType;
  status?: TaskStatus;
  message?: string;
  timestamp?: number;
  data?: unknown;
  metadata?: TaskMetadata;
}

export interface AddTaskOutputRefInput {
  id?: string;
  taskId: string;
  type: TaskOutputRefType;
  label?: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  createdAt?: number;
  metadata?: TaskMetadata;
}

export interface QueueTaskNotificationInput {
  id?: string;
  taskId: string;
  sessionId?: string;
  type: TaskNotificationType;
  title?: string;
  message: string;
  createdAt?: number;
  payload?: unknown;
  metadata?: TaskMetadata;
}

export interface ListTasksFilter {
  sessionId?: string;
  status?: TaskStatus | TaskStatus[];
  source?: TaskSource | TaskSource[];
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'expired',
  'orphaned',
] as const;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}
