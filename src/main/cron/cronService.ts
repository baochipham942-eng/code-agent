// ============================================================================
// CronService - Scheduled task execution service
// ============================================================================

import { Cron } from 'croner';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../shared/constants';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronJobStatus,
  CronScheduleType,
  CronScheduleConfig,
  CronJobAction,
  CronServiceStats,
  TimeUnit,
} from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import type { Disposable } from '../services/serviceRegistry';
import { getServiceRegistry } from '../services/serviceRegistry';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { notificationService } from '../services/infra/notificationService';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

interface ActiveJob {
  definition: CronJobDefinition;
  cronInstance?: Cron;
  nextRun?: Date;
}

interface JobExecutionContext {
  execution: CronJobExecution;
  startTime: number;
}

interface CronAgentActionResult {
  agentType: string;
  prompt: string;
  result: unknown;
  sessionId: string;
}

interface CronExecutionRow {
  id: string;
  job_id: string;
  session_id?: string | null;
  status: CronJobStatus;
  scheduled_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  duration?: number | null;
  result?: string | null;
  error?: string | null;
  retry_attempt: number;
  exit_code?: number | null;
}

const CRON_JOB_STATUSES: readonly CronJobStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
];

const TIME_UNITS: readonly TimeUnit[] = ['seconds', 'minutes', 'hours', 'days', 'weeks'];

function isCronAgentActionResult(value: unknown): value is CronAgentActionResult {
  return isRecord(value) && typeof value.sessionId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalNumberField(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = readNumberField(record, key);
  return value === 0 ? undefined : value;
}

function readNullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNullableNumberField(record: Record<string, unknown>, key: string): number | null {
  return readNumberField(record, key) ?? null;
}

function parseJsonValue(raw: unknown): unknown | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isCronScheduleType(value: unknown): value is CronScheduleType {
  return value === 'at' || value === 'every' || value === 'cron';
}

function isCronJobStatus(value: unknown): value is CronJobStatus {
  return CRON_JOB_STATUSES.includes(value as CronJobStatus);
}

function isTimeUnit(value: unknown): value is TimeUnit {
  return TIME_UNITS.includes(value as TimeUnit);
}

function isFiniteScheduleTimestamp(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return undefined;
    }
    normalized[key] = item;
  }
  return normalized;
}

function normalizeUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function normalizeSchedule(value: unknown): CronScheduleConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.type) {
    case 'at': {
      if (!isFiniteScheduleTimestamp(value.datetime)) {
        return null;
      }
      return { type: 'at', datetime: value.datetime };
    }

    case 'every': {
      const interval = readNumberField(value, 'interval');
      if (!interval || !isTimeUnit(value.unit)) {
        return null;
      }

      const schedule: CronScheduleConfig = {
        type: 'every',
        interval,
        unit: value.unit,
      };

      if (isFiniteScheduleTimestamp(value.startAt)) {
        schedule.startAt = value.startAt;
      }
      if (isFiniteScheduleTimestamp(value.endAt)) {
        schedule.endAt = value.endAt;
      }
      return schedule;
    }

    case 'cron': {
      if (typeof value.expression !== 'string') {
        return null;
      }

      return {
        type: 'cron',
        expression: value.expression,
        timezone: typeof value.timezone === 'string' ? value.timezone : undefined,
      };
    }

    default:
      return null;
  }
}

function normalizeAction(value: unknown): CronJobAction | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.type) {
    case 'shell': {
      if (typeof value.command !== 'string') {
        return null;
      }
      return {
        type: 'shell',
        command: value.command,
        cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
        env: normalizeStringRecord(value.env),
        usePty: typeof value.usePty === 'boolean' ? value.usePty : undefined,
      };
    }

    case 'tool': {
      if (typeof value.toolName !== 'string') {
        return null;
      }
      return {
        type: 'tool',
        toolName: value.toolName,
        parameters: normalizeUnknownRecord(value.parameters) ?? {},
      };
    }

    case 'agent': {
      if (typeof value.agentType !== 'string' || typeof value.prompt !== 'string') {
        return null;
      }
      return {
        type: 'agent',
        agentType: value.agentType,
        prompt: value.prompt,
        context: normalizeUnknownRecord(value.context),
      };
    }

    case 'webhook': {
      if (
        typeof value.url !== 'string' ||
        (value.method !== 'GET' &&
          value.method !== 'POST' &&
          value.method !== 'PUT' &&
          value.method !== 'DELETE')
      ) {
        return null;
      }
      return {
        type: 'webhook',
        url: value.url,
        method: value.method,
        headers: normalizeStringRecord(value.headers),
        body: value.body,
      };
    }

    case 'ipc': {
      if (typeof value.channel !== 'string') {
        return null;
      }
      return {
        type: 'ipc',
        channel: value.channel,
        payload: value.payload,
      };
    }

    case 'memory-consolidation': {
      return {
        type: 'memory-consolidation',
        dryRun: typeof value.dryRun === 'boolean' ? value.dryRun : undefined,
      };
    }

    case 'role-wake': {
      if (typeof value.roleId !== 'string') {
        return null;
      }
      return {
        type: 'role-wake',
        roleId: value.roleId,
      };
    }

    default:
      return null;
  }
}

function normalizeCronJobRow(row: unknown): CronJobDefinition | null {
  if (!isRecord(row)) {
    return null;
  }

  const id = readStringField(row, 'id');
  const name = readStringField(row, 'name');
  const scheduleType = row.schedule_type;
  const createdAt = readNumberField(row, 'created_at');
  const updatedAt = readNumberField(row, 'updated_at');
  const schedule = normalizeSchedule(parseJsonValue(row.schedule));
  const action = normalizeAction(parseJsonValue(row.action));

  if (
    !id ||
    !name ||
    !isCronScheduleType(scheduleType) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    !schedule ||
    !action
  ) {
    return null;
  }

  return {
    id,
    name,
    description: readStringField(row, 'description') || undefined,
    scheduleType,
    schedule,
    action,
    enabled: row.enabled === 1 || row.enabled === true,
    maxRetries: readOptionalNumberField(row, 'max_retries'),
    retryDelay: readOptionalNumberField(row, 'retry_delay'),
    timeout: readOptionalNumberField(row, 'timeout'),
    tags: normalizeTags(parseJsonValue(row.tags)),
    metadata: normalizeUnknownRecord(parseJsonValue(row.metadata)),
    createdAt,
    updatedAt,
  };
}

function normalizeCronExecutionRow(row: unknown): CronExecutionRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const id = readStringField(row, 'id');
  const jobId = readStringField(row, 'job_id');
  const status = row.status;
  const scheduledAt = readNumberField(row, 'scheduled_at');
  const retryAttempt = readNumberField(row, 'retry_attempt');

  if (
    !id ||
    !jobId ||
    !isCronJobStatus(status) ||
    scheduledAt === undefined ||
    retryAttempt === undefined
  ) {
    return null;
  }

  return {
    id,
    job_id: jobId,
    session_id: readNullableStringField(row, 'session_id'),
    status,
    scheduled_at: scheduledAt,
    started_at: readNullableNumberField(row, 'started_at'),
    completed_at: readNullableNumberField(row, 'completed_at'),
    duration: readNullableNumberField(row, 'duration'),
    result: readNullableStringField(row, 'result'),
    error: readNullableStringField(row, 'error'),
    retry_attempt: retryAttempt,
    exit_code: readNullableNumberField(row, 'exit_code'),
  };
}

// ============================================================================
// CronService
// ============================================================================

export class CronService implements Disposable {
  private jobs: Map<string, ActiveJob> = new Map();
  private executions: Map<string, CronJobExecution[]> = new Map();
  private isInitialized = false;
  private disposed = false;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Load jobs from database
    await this.loadJobsFromDatabase();

    this.isInitialized = true;
    console.error('[CronService] Initialized');
  }

  async shutdown(): Promise<void> {
    // Stop all cron jobs
    for (const [jobId, job] of this.jobs) {
      if (job.cronInstance) {
        job.cronInstance.stop();
        console.error(`[CronService] Stopped job: ${jobId}`);
      }
    }

    this.jobs.clear();
    this.isInitialized = false;
    console.error('[CronService] Shutdown complete');
  }

  // --------------------------------------------------------------------------
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.shutdown();
    } catch (error) {
      console.error('[CronService] Error during dispose:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Job Management
  // --------------------------------------------------------------------------

  /**
   * Create a new cron job
   */
  async createJob(
    definition: Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<CronJobDefinition> {
    const now = Date.now();

    // 一次性（at）任务护栏：datetime 必须是将来时间。
    // 否则（如 LLM 把「明天」算成过去）任务会静默不跑，用户却看到「创建成功」。
    if (definition.scheduleType === 'at' && definition.schedule?.type === 'at') {
      const raw = definition.schedule.datetime;
      const ts = typeof raw === 'number' ? raw : Date.parse(String(raw));
      if (Number.isNaN(ts)) {
        throw new Error(`定时任务时间无法解析：${String(raw)}`);
      }
      if (ts <= now) {
        throw new Error(
          `定时任务时间已过去（${new Date(ts).toLocaleString('zh-CN')}），请改成将来的时间`,
        );
      }
    }

    const job: CronJobDefinition = {
      ...definition,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    // Save to database
    await this.saveJobToDatabase(job);

    // Register and start if enabled
    if (job.enabled) {
      this.registerJob(job);
    } else {
      this.jobs.set(job.id, { definition: job });
    }

    return job;
  }

  /**
   * Update an existing job
   */
  async updateJob(
    jobId: string,
    updates: Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>
  ): Promise<CronJobDefinition | null> {
    const existingJob = this.jobs.get(jobId);
    if (!existingJob) return null;

    // Stop existing cron instance
    if (existingJob.cronInstance) {
      existingJob.cronInstance.stop();
    }

    const updatedJob: CronJobDefinition = {
      ...existingJob.definition,
      ...updates,
      updatedAt: Date.now(),
    };

    // Save to database
    await this.saveJobToDatabase(updatedJob);

    // Re-register if enabled
    if (updatedJob.enabled) {
      this.registerJob(updatedJob);
    } else {
      this.jobs.set(jobId, { definition: updatedJob });
    }

    return updatedJob;
  }

  /**
   * Delete a job
   */
  async deleteJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Stop cron instance
    if (job.cronInstance) {
      job.cronInstance.stop();
    }

    // Remove from memory
    this.jobs.delete(jobId);
    this.executions.delete(jobId);

    // Remove from database
    await this.deleteJobFromDatabase(jobId);

    return true;
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): CronJobDefinition | null {
    const job = this.jobs.get(jobId);
    return job ? this.withRuntimeScheduleState(job) : null;
  }

  /**
   * List all jobs
   */
  listJobs(filter?: { enabled?: boolean; tags?: string[] }): CronJobDefinition[] {
    let jobs = Array.from(this.jobs.values()).map((j) => this.withRuntimeScheduleState(j));

    if (filter?.enabled !== undefined) {
      jobs = jobs.filter((j) => j.enabled === filter.enabled);
    }

    if (filter?.tags && filter.tags.length > 0) {
      jobs = jobs.filter((j) =>
        j.tags?.some((tag) => filter.tags!.includes(tag))
      );
    }

    return jobs;
  }

  /**
   * Enable a job
   */
  async enableJob(jobId: string): Promise<boolean> {
    return !!(await this.updateJob(jobId, { enabled: true }));
  }

  /**
   * Disable a job
   */
  async disableJob(jobId: string): Promise<boolean> {
    return !!(await this.updateJob(jobId, { enabled: false }));
  }

  /**
   * Trigger a job immediately (outside of schedule)
   */
  async triggerJob(jobId: string): Promise<CronJobExecution | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    return this.executeJob(job.definition);
  }

  // --------------------------------------------------------------------------
  // Convenience Methods for Different Schedule Types
  // --------------------------------------------------------------------------

  /**
   * Schedule a one-time job at a specific time
   */
  async scheduleAt(
    datetime: Date | number | string,
    action: CronJobAction,
    options?: { name?: string; description?: string }
  ): Promise<CronJobDefinition> {
    const timestamp =
      typeof datetime === 'number'
        ? datetime
        : datetime instanceof Date
          ? datetime.getTime()
          : new Date(datetime).getTime();

    return this.createJob({
      name: options?.name || `One-time job at ${new Date(timestamp).toISOString()}`,
      description: options?.description,
      scheduleType: 'at',
      schedule: { type: 'at', datetime: timestamp },
      action,
      enabled: true,
    });
  }

  /**
   * Schedule a recurring job with interval
   */
  async scheduleEvery(
    interval: number,
    unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks',
    action: CronJobAction,
    options?: { name?: string; description?: string; startAt?: Date | number }
  ): Promise<CronJobDefinition> {
    return this.createJob({
      name: options?.name || `Every ${interval} ${unit}`,
      description: options?.description,
      scheduleType: 'every',
      schedule: {
        type: 'every',
        interval,
        unit,
        startAt: options?.startAt instanceof Date ? options.startAt.getTime() : options?.startAt,
      },
      action,
      enabled: true,
    });
  }

  /**
   * Schedule a job with cron expression
   */
  async scheduleCron(
    expression: string,
    action: CronJobAction,
    options?: { name?: string; description?: string; timezone?: string }
  ): Promise<CronJobDefinition> {
    return this.createJob({
      name: options?.name || `Cron: ${expression}`,
      description: options?.description,
      scheduleType: 'cron',
      schedule: {
        type: 'cron',
        expression,
        timezone: options?.timezone,
      },
      action,
      enabled: true,
    });
  }

  // --------------------------------------------------------------------------
  // Execution History
  // --------------------------------------------------------------------------

  /**
   * Get execution history for a job
   */
  getJobExecutions(jobId: string, limit: number = 10): CronJobExecution[] {
    const executions = this.executions.get(jobId) || [];
    if (executions.length > 0) {
      return executions.slice(-limit);
    }

    const persisted = this.loadExecutionsFromDatabase(jobId, limit);
    if (persisted.length > 0) {
      this.executions.set(jobId, persisted);
    }
    return persisted;
  }

  /**
   * Get the last execution for a job
   */
  getLastExecution(jobId: string): CronJobExecution | null {
    const executions = this.executions.get(jobId) || [];
    return executions[executions.length - 1] || null;
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /**
   * Get service statistics
   */
  getStats(): CronServiceStats {
    const allJobs = Array.from(this.jobs.values());
    const allExecutions = Array.from(this.executions.values()).flat();

    const successfulExecutions = allExecutions.filter((e) => e.status === 'completed').length;
    const failedExecutions = allExecutions.filter((e) => e.status === 'failed').length;

    return {
      totalJobs: allJobs.length,
      activeJobs: allJobs.filter((j) => j.definition.enabled).length,
      jobsByStatus: {
        pending: 0,
        running: allExecutions.filter((e) => e.status === 'running').length,
        completed: successfulExecutions,
        failed: failedExecutions,
        cancelled: allExecutions.filter((e) => e.status === 'cancelled').length,
        paused: allJobs.filter((j) => !j.definition.enabled).length,
      },
      totalExecutions: allExecutions.length,
      successfulExecutions,
      failedExecutions,
      successRate: allExecutions.length > 0
        ? (successfulExecutions / allExecutions.length) * 100
        : 0,
      totalHeartbeats: 0, // Heartbeats are handled separately
      healthyHeartbeats: 0,
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private registerJob(definition: CronJobDefinition): void {
    const cronInstance = this.createCronInstance(definition);
    const nextRun = cronInstance?.nextRun();

    this.jobs.set(definition.id, {
      definition,
      cronInstance,
      nextRun: nextRun || undefined,
    });

    console.error(`[CronService] Registered job: ${definition.name} (${definition.id})`);
  }

  private withRuntimeScheduleState(job: ActiveJob): CronJobDefinition {
    const nextRun = job.cronInstance?.nextRun() ?? job.nextRun;
    return {
      ...job.definition,
      nextRunAt: nextRun instanceof Date ? nextRun.getTime() : undefined,
    };
  }

  private createCronInstance(definition: CronJobDefinition): Cron | undefined {
    const { schedule, id } = definition;

    const callback = async () => {
      await this.executeJob(definition);
    };

    try {
      switch (schedule.type) {
        case 'at': {
          const datetime = typeof schedule.datetime === 'number'
            ? new Date(schedule.datetime)
            : new Date(schedule.datetime);

          // Use croner for one-time scheduling
          return new Cron(datetime, { maxRuns: 1 }, callback);
        }

        case 'every': {
          // Convert interval to cron expression
          const cronExpr = this.intervalToCron(schedule.interval, schedule.unit);
          return new Cron(cronExpr, callback);
        }

        case 'cron': {
          return new Cron(
            schedule.expression,
            { timezone: schedule.timezone },
            callback
          );
        }

        default:
          console.error(`[CronService] Unknown schedule type for job ${id}`);
          return undefined;
      }
    } catch (error) {
      console.error(`[CronService] Failed to create cron instance for job ${id}:`, error);
      return undefined;
    }
  }

  private intervalToCron(interval: number, unit: string): string {
    switch (unit) {
      case 'seconds':
        return `*/${interval} * * * * *`;
      case 'minutes':
        return `0 */${interval} * * * *`;
      case 'hours':
        return `0 0 */${interval} * * *`;
      case 'days':
        return `0 0 0 */${interval} * *`;
      case 'weeks':
        return `0 0 0 * * ${interval}`;
      default:
        return `0 */${interval} * * * *`; // Default to minutes
    }
  }

  private async executeJob(definition: CronJobDefinition): Promise<CronJobExecution> {
    const execution: CronJobExecution = {
      id: uuidv4(),
      jobId: definition.id,
      status: 'running',
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      retryAttempt: 0,
    };

    // Store execution
    if (!this.executions.has(definition.id)) {
      this.executions.set(definition.id, []);
    }
    this.executions.get(definition.id)!.push(execution);

    // Limit execution history to 100 entries per job
    const history = this.executions.get(definition.id)!;
    if (history.length > 100) {
      this.executions.set(definition.id, history.slice(-100));
    }

    try {
      const result = await this.executeAction(definition, definition.action, definition.timeout, execution.id);
      if (isCronAgentActionResult(result)) {
        execution.sessionId = result.sessionId;
      }
      execution.status = 'completed';
      execution.result = result;
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);

      // Handle retries
      if (definition.maxRetries && execution.retryAttempt < definition.maxRetries) {
        await this.retryExecution(definition, execution);
      }
    } finally {
      execution.completedAt = Date.now();
      execution.duration = execution.completedAt - execution.startedAt!;

      // For one-time jobs, disable after execution
      if (definition.scheduleType === 'at') {
        await this.updateJob(definition.id, { enabled: false });
      }

      // Save execution to database
      await this.saveExecutionToDatabase(execution);

      // 定时 agent 任务执行完成后发系统通知，点通知跳到生成的 session
      this.notifyAgentExecution(definition, execution);
    }

    return execution;
  }

  /**
   * 定时 agent 任务跑完后发完成通知。
   * 只对生成了会话的 agent action 发——点击通知经 NOTIFICATION_CLICKED 跳到该 session。
   */
  private notifyAgentExecution(definition: CronJobDefinition, execution: CronJobExecution): void {
    if (definition.action.type !== 'agent' || !execution.sessionId) return;
    try {
      const succeeded = execution.status === 'completed';
      notificationService.notifyTaskComplete(
        {
          sessionId: execution.sessionId,
          sessionTitle: `[定时] ${definition.name}`,
          summary: succeeded ? '定时任务已完成' : `定时任务失败：${execution.error ?? '未知错误'}`,
          duration: execution.duration ?? 0,
          toolsUsed: [],
          succeeded,
        },
        { force: true }, // 后台定时任务完成：绕过焦点门，app 前台/后台都提醒
      );
    } catch (err) {
      console.error('[CronService] notifyAgentExecution failed:', err);
    }
  }

  private async executeAction(
    definition: CronJobDefinition,
    action: CronJobAction,
    timeout?: number,
    executionId?: string
  ): Promise<unknown> {
    switch (action.type) {
      case 'shell': {
        const { stdout, stderr } = await execAsync(action.command, {
          cwd: action.cwd,
          env: { ...process.env, ...action.env },
          timeout: timeout || 60000,
        });
        return { stdout, stderr };
      }

      case 'tool': {
        // Tool execution would need to be integrated with the tool executor
        // For now, return a placeholder
        console.error(`[CronService] Would execute tool: ${action.toolName}`);
        return { toolName: action.toolName, parameters: action.parameters };
      }

      case 'agent': {
        // Heartbeat 任务: 检查 active_hours 窗口
        const ctx = action.context as Record<string, unknown> | undefined;
        if (ctx?.heartbeatTask && ctx?.activeHours) {
          const { isWithinActiveHours } = await import('./heartbeatTaskLoader');
          if (!isWithinActiveHours(ctx.activeHours as string)) {
            console.error(`[CronService] Heartbeat task skipped (outside active hours: ${ctx.activeHours})`);
            return { skipped: true, reason: 'outside_active_hours' };
          }
        }

        // 通过 TaskManager 获取 orchestrator（避免 cronService → bootstrap 循环依赖）
        const { getTaskManager } = await import('../task');
        const tm = getTaskManager();
        const cronSession = await this.createCronAgentSession(definition, action, executionId);
        const orchestrator = tm.getOrCreateCurrentOrchestrator(cronSession.id) ?? null;
        if (!orchestrator) {
          throw new Error(`AgentOrchestrator not available for cron session ${cronSession.id}`);
        }
        if (cronSession.workingDirectory) {
          tm.setWorkingDirectory(cronSession.id, cronSession.workingDirectory);
        }

        let result: unknown;
        try {
          result = await orchestrator.sendMessage(action.prompt);
        } finally {
          tm.cleanup(cronSession.id);
        }

        // Heartbeat 任务: channel 推送
        if (ctx?.heartbeatTask && ctx?.channel && result) {
          try {
            const { getChannelManager } = await import('../channels/channelManager');
            const channelManager = getChannelManager();
            const accounts = channelManager.getAllAccounts();
            const targetAccount = accounts.find(a => a.type === ctx!.channel || a.name === ctx!.channel);
            if (targetAccount) {
              await channelManager.sendMessage(targetAccount.id, targetAccount.id, String(result));
              console.error(`[CronService] Heartbeat result pushed to channel: ${ctx.channel}`);
            }
          } catch (pushError) {
            console.warn(`[CronService] Failed to push heartbeat result to channel: ${ctx.channel}`, pushError);
          }
        }

        return { agentType: action.agentType, prompt: action.prompt, result, sessionId: cronSession.id };
      }

      case 'webhook': {
        const response = await fetch(action.url, {
          method: action.method,
          headers: action.headers,
          body: action.body ? JSON.stringify(action.body) : undefined,
        });
        return { status: response.status, body: await response.text() };
      }

      case 'ipc': {
        // IPC would need to be integrated with the IPC system
        console.error(`[CronService] Would send IPC: ${action.channel}`);
        return { channel: action.channel, payload: action.payload };
      }

      case 'memory-consolidation': {
        // Internal maintenance: compress Light Memory without losing information.
        const { consolidateLightMemory } = await import('../lightMemory/consolidation');
        const report = await consolidateLightMemory({ dryRun: action.dryRun ?? false });
        console.error(
          `[CronService] Memory consolidation ${report.applied ? 'applied' : 'no-op'}`
          + ` (dryRun=${report.dryRun}, triggered=${report.triggered}, actions=${report.actions.length}): ${report.reason}`,
        );
        return report;
      }

      case 'role-wake': {
        // 角色主动性：cadence 到点 → 完整醒来循环（docs/designs/role-proactivity.md）
        const { wakeRole } = await import('../services/roleAssets/roleProactivity');
        const wakeResult = await wakeRole(action.roleId, 'cadence');
        console.error(
          `[CronService] Role wake ${wakeResult.status}`
          + ` (role=${wakeResult.roleId}, decision=${wakeResult.decision ?? '-'}, session=${wakeResult.sessionId ?? '-'})`
          + (wakeResult.skipReason ? `: ${wakeResult.skipReason}` : ''),
        );
        return wakeResult;
      }

      default:
        throw new Error(`Unknown action type`);
    }
  }

  private getAgentSessionType(action: CronJobAction): 'schedule' | 'heartbeat' {
    if (action.type === 'agent' && action.context?.heartbeatTask) {
      return 'heartbeat';
    }
    return 'schedule';
  }

  private formatAgentSessionTitle(definition: CronJobDefinition, sessionType: 'schedule' | 'heartbeat'): string {
    const cleanName = definition.name.replace(/^\[(Cron|Schedule|Heartbeat)\]\s*/i, '').trim() || definition.name;
    return sessionType === 'heartbeat'
      ? `[Heartbeat] ${cleanName}`
      : `[Schedule] ${cleanName}`;
  }

  private async createCronAgentSession(
    definition: CronJobDefinition,
    action: CronJobAction,
    executionId?: string
  ) {
    const { getConfigService, getSessionManager } = await import('../services');

    const configService = getConfigService();
    const sessionManager = getSessionManager();
    const currentSessionId = sessionManager.getCurrentSessionId();
    const currentSession = currentSessionId
      ? await sessionManager.getSession(currentSessionId)
      : null;
    const settings = configService.getSettings();
    const sessionType = this.getAgentSessionType(action);
    const originKind = sessionType === 'heartbeat' ? 'heartbeat' : 'cron';

    return sessionManager.createSession({
      title: this.formatAgentSessionTitle(definition, sessionType),
      modelConfig: resolveSessionDefaultModelConfig({
        provider: settings.model?.provider || currentSession?.modelConfig.provider || DEFAULT_PROVIDER,
        model: settings.model?.model || currentSession?.modelConfig.model || DEFAULT_MODELS.chat,
        temperature: settings.model?.temperature ?? currentSession?.modelConfig.temperature ?? 0.7,
        maxTokens: settings.model?.maxTokens ?? currentSession?.modelConfig.maxTokens,
      }),
      workingDirectory: currentSession?.workingDirectory,
      type: sessionType,
      origin: {
        kind: originKind,
        id: definition.id,
        name: definition.name,
        metadata: {
          scheduleType: definition.scheduleType,
          actionType: action.type,
        },
      },
      sourceRunId: executionId,
      readOnly: true,
    });
  }

  private async retryExecution(
    definition: CronJobDefinition,
    execution: CronJobExecution
  ): Promise<void> {
    const delay = definition.retryDelay || 5000;

    await new Promise((resolve) => setTimeout(resolve, delay));

    execution.retryAttempt++;
    execution.status = 'running';
    execution.startedAt = Date.now();

    try {
      const result = await this.executeAction(definition, definition.action, definition.timeout, execution.id);
      if (isCronAgentActionResult(result)) {
        execution.sessionId = result.sessionId;
      }
      execution.status = 'completed';
      execution.result = result;
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);

      // Continue retrying if we haven't reached the limit
      if (execution.retryAttempt < (definition.maxRetries || 0)) {
        await this.retryExecution(definition, execution);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Database Operations
  // --------------------------------------------------------------------------

  private async loadJobsFromDatabase(): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) {
        console.error('[CronService] Database not available, starting with empty jobs');
        return;
      }
      const rows = db.prepare('SELECT * FROM cron_jobs').all() as unknown[];
      let loadedCount = 0;
      for (const row of rows) {
        const job = normalizeCronJobRow(row);
        if (!job) {
          console.error('[CronService] Skipping invalid cron job row');
          continue;
        }

        if (job.enabled) {
          this.registerJob(job);
        } else {
          this.jobs.set(job.id, { definition: job });
        }
        loadedCount += 1;
      }
      console.error(`[CronService] Loaded ${loadedCount} jobs from database`);
    } catch (error) {
      console.error('[CronService] Failed to load jobs from database:', error);
    }
  }

  private async saveJobToDatabase(job: CronJobDefinition): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) return;
      db.prepare(`
        INSERT OR REPLACE INTO cron_jobs
        (id, name, description, schedule_type, schedule, action, enabled, max_retries, retry_delay, timeout, tags, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id, job.name, job.description || null,
        job.scheduleType, JSON.stringify(job.schedule), JSON.stringify(job.action),
        job.enabled ? 1 : 0, job.maxRetries || 0, job.retryDelay || 5000,
        job.timeout || 60000, job.tags ? JSON.stringify(job.tags) : null,
        job.metadata ? JSON.stringify(job.metadata) : '{}',
        job.createdAt, job.updatedAt
      );
    } catch (error) {
      console.error('[CronService] Failed to save job to database:', error);
    }
  }

  private loadExecutionsFromDatabase(jobId: string, limit: number): CronJobExecution[] {
    try {
      const db = getDatabase().getDb();
      if (!db) return [];

      const rows = db.prepare(`
        SELECT *
        FROM cron_executions
        WHERE job_id = ?
        ORDER BY scheduled_at DESC
        LIMIT ?
      `).all(jobId, limit) as unknown[];

      return rows.reverse().map(normalizeCronExecutionRow).filter((row): row is CronExecutionRow => row !== null).map((row) => ({
        id: row.id,
        jobId: row.job_id,
        sessionId: row.session_id || undefined,
        status: row.status,
        scheduledAt: row.scheduled_at,
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        duration: row.duration ?? undefined,
        result: parseJsonValue(row.result),
        error: row.error || undefined,
        retryAttempt: row.retry_attempt,
        exitCode: row.exit_code ?? undefined,
      }));
    } catch (error) {
      console.error('[CronService] Failed to load executions from database:', error);
      return [];
    }
  }

  private async deleteJobFromDatabase(jobId: string): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) return;
      db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(jobId);
    } catch (error) {
      console.error('[CronService] Failed to delete job from database:', error);
    }
  }

  private async saveExecutionToDatabase(execution: CronJobExecution): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) return;
      db.prepare(`
        INSERT INTO cron_executions
        (id, job_id, session_id, status, scheduled_at, started_at, completed_at, duration, result, error, retry_attempt, exit_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        execution.id, execution.jobId, execution.sessionId || null, execution.status,
        execution.scheduledAt, execution.startedAt || null,
        execution.completedAt || null, execution.duration || null,
        execution.result ? JSON.stringify(execution.result) : null,
        execution.error || null, execution.retryAttempt,
        execution.exitCode || null
      );
    } catch (error) {
      console.error('[CronService] Failed to save execution to database:', error);
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let cronServiceInstance: CronService | null = null;

export function getCronService(): CronService {
  if (!cronServiceInstance) {
    cronServiceInstance = new CronService();
    getServiceRegistry().register('CronService', cronServiceInstance);
  }
  return cronServiceInstance;
}

export async function initCronService(): Promise<CronService> {
  const service = getCronService();
  await service.initialize();
  return service;
}
