// ============================================================================
// Cron Types - Type definitions for scheduled tasks and heartbeats
// ============================================================================

/**
 * Cron job schedule types
 */
export type CronScheduleType = 'at' | 'every' | 'cron';

/**
 * Cron job status
 */
export type CronJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

/**
 * Time unit for interval-based scheduling
 */
export type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks';

/**
 * Cron job definition
 */
export interface CronJobDefinition {
  /** Unique identifier for the job */
  id: string;
  /** Human-readable name for the job */
  name: string;
  /** Description of what this job does */
  description?: string;
  /** Schedule type: 'at' (one-time), 'every' (interval), or 'cron' (cron expression) */
  scheduleType: CronScheduleType;
  /** Schedule configuration */
  schedule: CronScheduleConfig;
  /** The action to execute */
  action: CronJobAction;
  /** Whether the job is enabled */
  enabled: boolean;
  /** Maximum number of retries on failure */
  maxRetries?: number;
  /** Delay between retries in milliseconds */
  retryDelay?: number;
  /** Timeout for job execution in milliseconds */
  timeout?: number;
  /** Tags for categorization */
  tags?: string[];
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Schedule configuration based on schedule type
 */
export type CronScheduleConfig =
  | AtScheduleConfig
  | EveryScheduleConfig
  | CronExpressionConfig;

/**
 * One-time schedule at a specific time
 */
export interface AtScheduleConfig {
  type: 'at';
  /** ISO 8601 timestamp or Unix timestamp */
  datetime: string | number;
}

/**
 * Interval-based schedule
 */
export interface EveryScheduleConfig {
  type: 'every';
  /** Interval value */
  interval: number;
  /** Time unit */
  unit: TimeUnit;
  /** Optional start time */
  startAt?: string | number;
  /** Optional end time */
  endAt?: string | number;
}

/**
 * Cron expression schedule
 */
export interface CronExpressionConfig {
  type: 'cron';
  /** Standard cron expression (5 or 6 fields) */
  expression: string;
  /** Timezone for the cron expression */
  timezone?: string;
}

/**
 * Action types for cron jobs
 */
export type CronJobActionType = 'shell' | 'tool' | 'agent' | 'webhook' | 'ipc';

/**
 * Cron job action definition
 */
export type CronJobAction =
  | ShellAction
  | ToolAction
  | AgentAction
  | WebhookAction
  | IpcAction;

/**
 * Shell command action
 */
export interface ShellAction {
  type: 'shell';
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  usePty?: boolean;
}

/**
 * Tool execution action
 */
export interface ToolAction {
  type: 'tool';
  toolName: string;
  parameters: Record<string, unknown>;
}

/**
 * Agent execution action
 */
export interface AgentAction {
  type: 'agent';
  agentType: string;
  prompt: string;
  context?: Record<string, unknown>;
}

/**
 * Webhook action
 */
export interface WebhookAction {
  type: 'webhook';
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * IPC message action
 */
export interface IpcAction {
  type: 'ipc';
  channel: string;
  payload: unknown;
}

/**
 * Cron job execution record
 */
export interface CronJobExecution {
  /** Unique execution ID */
  id: string;
  /** Reference to the job */
  jobId: string;
  /** Execution status */
  status: CronJobStatus;
  /** Scheduled execution time */
  scheduledAt: number;
  /** Actual start time */
  startedAt?: number;
  /** Completion time */
  completedAt?: number;
  /** Duration in milliseconds */
  duration?: number;
  /** Execution result */
  result?: unknown;
  /** Error message if failed */
  error?: string;
  /** Retry attempt number (0 = first attempt) */
  retryAttempt: number;
  /** Exit code for shell commands */
  exitCode?: number;
}

/**
 * Heartbeat configuration
 */
export interface HeartbeatConfig {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Interval in milliseconds */
  interval: number;
  /** The check to perform */
  check: HeartbeatCheck;
  /** Expected result condition */
  expectation?: HeartbeatExpectation;
  /** Alert configuration */
  alert?: HeartbeatAlert;
  /** Whether enabled */
  enabled: boolean;
  /** Consecutive failures before alert */
  failureThreshold?: number;
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Heartbeat check types
 */
export type HeartbeatCheck =
  | ShellHealthCheck
  | HttpHealthCheck
  | ToolHealthCheck;

/**
 * Shell-based health check
 */
export interface ShellHealthCheck {
  type: 'shell';
  command: string;
  cwd?: string;
  expectedExitCode?: number;
}

/**
 * HTTP health check
 */
export interface HttpHealthCheck {
  type: 'http';
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  timeout?: number;
}

/**
 * Tool-based health check
 */
export interface ToolHealthCheck {
  type: 'tool';
  toolName: string;
  parameters: Record<string, unknown>;
}

/**
 * Heartbeat expectation
 */
export interface HeartbeatExpectation {
  /** Check output contains this string */
  contains?: string;
  /** Check output matches this regex */
  matches?: string;
  /** Check output equals this value */
  equals?: string;
  /** Custom validation function (serialized) */
  customValidator?: string;
}

/**
 * Heartbeat alert configuration
 */
export interface HeartbeatAlert {
  /** Alert via IPC to renderer */
  ipc?: boolean;
  /** Alert via system notification */
  notification?: boolean;
  /** Alert via webhook */
  webhook?: string;
  /** Custom alert action */
  customAction?: CronJobAction;
}

/**
 * Heartbeat status record
 */
export interface HeartbeatStatus {
  /** Reference to heartbeat config */
  heartbeatId: string;
  /** Current status */
  status: 'healthy' | 'unhealthy' | 'unknown';
  /** Last check time */
  lastCheckAt?: number;
  /** Last successful check time */
  lastSuccessAt?: number;
  /** Last failure time */
  lastFailureAt?: number;
  /** Consecutive failures */
  consecutiveFailures: number;
  /** Last error message */
  lastError?: string;
  /** Uptime percentage (last 24 hours) */
  uptimePercentage?: number;
}

/**
 * Cron service statistics
 */
export interface CronServiceStats {
  /** Total jobs registered */
  totalJobs: number;
  /** Active (enabled) jobs */
  activeJobs: number;
  /** Jobs by status */
  jobsByStatus: Record<CronJobStatus, number>;
  /** Total executions */
  totalExecutions: number;
  /** Successful executions */
  successfulExecutions: number;
  /** Failed executions */
  failedExecutions: number;
  /** Success rate percentage */
  successRate: number;
  /** Total heartbeats */
  totalHeartbeats: number;
  /** Healthy heartbeats */
  healthyHeartbeats: number;
}
