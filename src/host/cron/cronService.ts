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
import {
  readCronSourceSessionId,
  recordCronAutomationCreated,
  syncCronAutomationFromJob,
  recordCronAutomationArchived,
  recordCronAutomationExecution,
  type ResolveRuntimeDefinition,
} from './cronAutomationBridge';
import {
  isCronAgentActionResult,
  normalizeCronJobRow,
  normalizeCronExecutionRow,
  assertSupportedEveryScheduleUnit,
  parseJsonValue,
  type CronExecutionRow,
  type SupportedEveryTimeUnit,
} from './cronNormalizers';

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
    assertSupportedEveryScheduleUnit(definition.schedule);

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

    await recordCronAutomationCreated(job, this.resolveAutomationRuntime);

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
    assertSupportedEveryScheduleUnit(updatedJob.schedule);

    // Save to database
    await this.saveJobToDatabase(updatedJob);

    // Re-register if enabled
    if (updatedJob.enabled) {
      this.registerJob(updatedJob);
    } else {
      this.jobs.set(jobId, { definition: updatedJob });
    }

    syncCronAutomationFromJob(updatedJob, this.resolveAutomationRuntime);

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
    await recordCronAutomationArchived(job.definition);

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
    unit: SupportedEveryTimeUnit,
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
        throw new Error('Unsupported interval unit "weeks"; cron day-of-week syntax cannot express every N weeks.');
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

      await recordCronAutomationExecution(definition, execution, this.resolveAutomationRuntime);

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
        // 角色主动性：cadence 到点 → 完整醒来循环（内部文档）
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
    const sourceSessionId = readCronSourceSessionId(definition, action);
    const sourceSession = sourceSessionId
      ? await sessionManager.getSession(sourceSessionId).catch(() => null)
      : null;
    const currentSession = currentSessionId
      ? await sessionManager.getSession(currentSessionId)
      : null;
    const baseSession = sourceSession ?? currentSession;
    const settings = configService.getSettings();
    const sessionType = this.getAgentSessionType(action);
    const originKind = sessionType === 'heartbeat' ? 'heartbeat' : 'cron';

    return sessionManager.createSession({
      title: this.formatAgentSessionTitle(definition, sessionType),
      modelConfig: resolveSessionDefaultModelConfig({
        provider: settings.model?.provider || baseSession?.modelConfig.provider || DEFAULT_PROVIDER,
        model: settings.model?.model || baseSession?.modelConfig.model || DEFAULT_MODELS.chat,
        temperature: settings.model?.temperature ?? baseSession?.modelConfig.temperature ?? 0.7,
        maxTokens: settings.model?.maxTokens ?? baseSession?.modelConfig.maxTokens,
      }),
      workingDirectory: baseSession?.workingDirectory,
      type: sessionType,
      origin: {
        kind: originKind,
        id: definition.id,
        name: definition.name,
        metadata: {
          scheduleType: definition.scheduleType,
          actionType: action.type,
          sourceSessionId,
        },
      },
      parentSessionId: sourceSessionId,
      sourceRunId: executionId,
      readOnly: true,
    });
  }

  /**
   * 供 automation 桥接复用：解析定时任务的运行时定义（带最新 nextRunAt）。
   * 从内存 job 表取实时调度状态，取不到回退到原始 definition。
   */
  private readonly resolveAutomationRuntime: ResolveRuntimeDefinition = (definition) => {
    const job = this.jobs.get(definition.id);
    return job ? this.withRuntimeScheduleState(job) : definition;
  };

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
