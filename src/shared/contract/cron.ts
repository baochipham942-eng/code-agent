// ============================================================================
// Cron Types - Type definitions for scheduled tasks and heartbeats
// ============================================================================

/**
 * Cron job schedule types.
 *
 * `event` jobs have no croner instance and no `nextRunAt`: they are fired by
 * locally connected channel inbound messages (see `EventScheduleConfig`).
 */
export type CronScheduleType = 'at' | 'every' | 'cron' | 'event';

/** Execution location selected when a job is created. */
export type CronRunsOn = 'local' | 'cloud';

/**
 * Cron job status.
 *
 * `interrupted` marks an execution record whose process died mid-run (app crash/quit
 * before its terminal status could be persisted) — detected and applied at startup.
 * Distinct from `cancelled` (deliberate user action) and `failed` (the action itself
 * errored while the app was alive to observe it).
 */
export type CronJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'interrupted';

/**
 * Why a scheduled occurrence was recorded missed.
 * `interrupted` = it did start, but the process died mid-run（启动扫描据此停用而不整趟重跑）；
 * `app-offline` = it never started because the app was down through the whole trigger window.
 */
export type CronMissedReason = 'app-offline' | 'interrupted';

export interface CronMissedEvent {
  jobId: string;
  scheduledAt: number;
  reason: CronMissedReason;
}

/**
 * Time unit for interval-based scheduling.
 *
 * `weeks` is intentionally excluded (audit 复核 HIGH-2): cron cannot represent
 * "every N weeks" without an anchored calendar policy, so it is rejected at the
 * type layer here AND at the CronService runtime/DB-load layer. UI dropdown also
 * omits it. Use a cron expression for weekly calendar schedules.
 */
export type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';

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
  /** Execution location. Frozen at creation; changing location requires a new job. */
  runsOn: CronRunsOn;
  /**
   * Optional per-run USD ceiling. This job-level gate is additive to the shared
   * unattended budget pool; it never replaces or disables that pool.
   * `null` on update clears a previously set value — JSON transport drops `undefined`
   * keys, which the host merge would read as "keep the old value".
   */
  maxRunBudget?: number | null;
  /**
   * Optional run-count cap (integer >= 1, local jobs only). The job auto-disables
   * with reason `max_runs_reached` once this many counted runs have finished.
   * `null` on update clears a previously set value (same JSON-transport reason as above).
   */
  maxRuns?: number | null;
  /**
   * Counted runs so far (one per settled run with terminal status completed/failed,
   * including runs that went through the retry chain; cancelled and capacity-wait
   * runs do not count). Read-only for callers; reset to 0 on re-enable.
   */
  runCount?: number;
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
  /** Optional Neo channel account type/name that receives this job's result. */
  resultChannel?: string;
  /** Computed next run timestamp. Returned by the runtime service; not persisted. */
  nextRunAt?: number;
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/** Backward-compatible create input: omitted runsOn is normalized to local. */
export type CreateCronJobDefinition = Omit<
  CronJobDefinition,
  'id' | 'createdAt' | 'updatedAt' | 'runsOn'
> & { runsOn?: CronRunsOn };

/**
 * Schedule configuration based on schedule type
 */
export type CronScheduleConfig =
  | AtScheduleConfig
  | EveryScheduleConfig
  | CronExpressionConfig
  | EventScheduleConfig;

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
  /** Time unit. Runtime supports seconds/minutes/hours/days; weeks is legacy compatibility only. */
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
 * Event-triggered schedule: the job is fired by inbound messages of a channel
 * account already connected on this machine (ChannelManager), not by time.
 * No listening port, no HTTP endpoint, no public callback is involved.
 */
export interface EventScheduleConfig {
  type: 'event';
  /** Event source; only locally connected channels exist today. */
  source: 'channel';
  /** Bound channel account id — only this account's messages trigger the job. No wildcard. */
  accountId: string;
  /** Optional chat restriction; unset means any chat on the bound account. */
  chatId?: string;
  /** Event kind; only inbound 'message' exists today. */
  eventName: 'message';
  /** Events arriving within this window merge into one run (seconds). Default 10, max 300. */
  batchWindowSec?: number;
  /** Minimum spacing between two runs (seconds). Default 60, floor 30. */
  minRunIntervalSec?: number;
}

/**
 * Action types for cron jobs
 */
export type CronJobActionType = 'shell' | 'tool' | 'agent' | 'webhook' | 'ipc' | 'memory-consolidation' | 'role-wake';

/**
 * Cron job action definition
 */
export type CronJobAction =
  | ShellAction
  | ToolAction
  | AgentAction
  | WebhookAction
  | IpcAction
  | MemoryConsolidationAction
  | RoleWakeAction;

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
  /**
   * 以该持久化角色身份跑（roles/<roleId>/ 目录名）。设置后执行时注入
   * L0 角色定义（agentOverrideId）+ L1 记忆索引/资料架（buildRoleContextBlock →
   * turnSystemContext），复用 wakeRole 已验证的主会话链注入路径。
   * 角色不存在时降级为默认 agent 跑并告警，不中断任务（A6 D5）。
   */
  roleId?: string;
  /**
   * 产出归档到该项目资料库（projectId 或 'global'）。缺省不归档，保持现有
   * 任务行为零扰动（A6 D6）。填了才在跑完后复用 LibraryService 归档，标签「定稿」。
   */
  libraryProjectId?: string;
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
 * Light Memory consolidation action — runs the compress-without-loss pass over
 * ~/.code-agent/memory/ using the quick model. An internal maintenance job; does
 * not spin up a full agent session.
 */
export interface MemoryConsolidationAction {
  type: 'memory-consolidation';
  /** When true, compute the plan + diff but do not write to disk. */
  dryRun?: boolean;
}

/**
 * Role wake action — 角色主动性 cadence 触发器（内部文档）。
 * cron 到点后调 roleProactivityService.wakeRole() 执行完整醒来循环
 * （带记忆实例化 → 检查履历产物 → 推进/汇报/建议/沉默 → 写回销毁）。
 */
export interface RoleWakeAction {
  type: 'role-wake';
  /** 持久化角色 ID（roles/<roleId>/ 目录名） */
  roleId: string;
}

/**
 * Why an execution ran. Schedule-triggered runs keep this undefined (or carry
 * `{ kind: 'schedule' }`); event-triggered runs describe the triggering events.
 */
export interface CronExecutionTrigger {
  kind: 'event' | 'schedule';
  /** Event source; only 'channel' (locally connected channel messages) exists today. */
  source?: 'channel';
  /** Channel account whose messages fired the run. */
  accountId?: string;
  /** Number of events carried into this run. */
  eventCount?: number;
  /** Events dropped (queue overflow or per-run cap) instead of carried. */
  droppedCount?: number;
  /** Platform message ids of the carried events. */
  eventIds?: string[];
}

/**
 * Cron job execution record
 */
export interface CronJobExecution {
  /** Unique execution ID */
  id: string;
  /** Reference to the job */
  jobId: string;
  /** Execution-location snapshot resolved when the run was created. */
  runsOn?: CronRunsOn;
  /** Session generated by this execution when the action runs an agent */
  sessionId?: string;
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
  /** Trigger descriptor: why this run happened (event runs only). */
  trigger?: CronExecutionTrigger;
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
