// ============================================================================
// CronService - Scheduled task execution service
// ============================================================================

import { Cron } from 'croner';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  CRON_AGENT_SNAPSHOT,
  CRON_GUARDRAILS,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  EXTERNAL_WATCH,
} from '../../shared/constants';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronJobAction,
  CronServiceStats,
  CronMissedEvent,
  CreateCronJobDefinition,
} from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import { getConfigService } from '../services/core/configService';
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
  getCronAutomationType,
  isSkippedResult,
  type ResolveRuntimeDefinition,
} from './cronAutomationBridge';
import {
  isCronAgentActionResult,
  normalizeCronJobRow,
  assertSupportedEveryScheduleUnit,
  type SupportedEveryTimeUnit,
} from './cronNormalizers';
import { buildCronAgentRunOptions } from './cronAgentRoleContext';
import { BACKGROUND_AGENT_EVENT_FILTER } from '../protocol/events/eventFilter';
import type { AgentRunOptions } from '../research/types';
import { getEventBus } from '../services/eventing/bus';
import { persistCronMissedTrace } from './cronMissedTrace';
import { appendCronAgentExpertThreadReceipt } from './cronAgentExpertThreadReceipt';
import { buildCronAgentPrompt, truncateUtf8Snapshot } from './cronAgentPrompt';
import {
  assertExecutionLocationConstraints,
  computeCronFireJitterMs,
  runWithCronJobBudget,
  scheduleBoundToDate,
} from './cronExecutionPolicy';
import { CronCloudRuntime } from './cronCloudRuntime';
import {
  deleteCronJob,
  loadCronExecutionStatus,
  mapCronExecutionRows,
  saveCronExecution,
  saveCronJob,
  upsertCronExecutionInMemory,
} from './cronPersistence';
import { pushCronResult } from './cronResultDelivery';
export { computeCronFireJitterMs } from './cronExecutionPolicy';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

interface ActiveJob {
  definition: CronJobDefinition;
  cronInstance?: Cron;
  nextRun?: Date;
  cloudJobId?: string;
}

// ============================================================================
// CronService
// ============================================================================

export class CronService implements Disposable {
  private jobs: Map<string, ActiveJob> = new Map();
  private executions: Map<string, CronJobExecution[]> = new Map();
  private isInitialized = false;
  private disposed = false;
  private unsubscribeCronMissed?: () => void;
  private cloudRuntime = new CronCloudRuntime(
    () => {
      const config = getConfigService().getSettings().cronCloud;
      const baseUrl = config?.baseUrl?.trim();
      const token = config?.token?.trim();
      return baseUrl && token ? { baseUrl, token } : undefined;
    },
    {
      getJobs: () => this.jobs.values(),
      persistJob: (definition, cloudJobId) => this.persistJob(definition, cloudJobId),
      persistExecution: async (execution) => {
        upsertCronExecutionInMemory(this.executions, execution);
        await saveCronExecution(execution);
      },
      loadExecutionStatus: loadCronExecutionStatus,
      unavailableMessage: () => getConfigService().getSettings().ui?.language === 'en'
        ? 'The cloud scheduler is unavailable, so the job was not run. Check the cloud scheduler URL and token, then try again.'
        : '云端计划任务服务暂时不可用，任务未执行。请检查云端执行地址和令牌后重试。',
      onCompleted: async (definition, execution, summary) => {
        await recordCronAutomationExecution(definition, execution, this.resolveAutomationRuntime);
        await pushCronResult(definition, summary);
        this.notifyAgentExecution(definition, execution);
        void this.notifyWakeOnJobCompleted(definition, execution);
      },
    },
  );

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.unsubscribeCronMissed ??= getEventBus().subscribe<CronMissedEvent>(
      'system:cron.missed',
      (event) => {
        console.error(`[CronService] cron.missed consumed for job ${event.data.jobId}`);
      },
    );

    // 中断可见性（maka 护栏自查 A5-④遗留）：上次运行中途被杀掉的执行记录会永远
    // 停在 running，让用户误以为还在跑。启动时先把这些残留行标记为 interrupted。
    await this.markInterruptedExecutions();

    // Load jobs from database
    await this.loadJobsFromDatabase();
    await this.cloudRuntime.reconcile();

    if (this.cloudRuntime.isConfigured()) {
      this.cloudRuntime.start();
    }

    this.isInitialized = true;
    console.error('[CronService] Initialized');
  }

  async shutdown(): Promise<void> {
    this.cloudRuntime.stop();
    // Stop all cron jobs
    for (const [jobId, job] of this.jobs) {
      if (job.cronInstance) {
        job.cronInstance.stop();
        console.error(`[CronService] Stopped job: ${jobId}`);
      }
    }

    this.jobs.clear();
    this.unsubscribeCronMissed?.();
    this.unsubscribeCronMissed = undefined;
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
    definition: CreateCronJobDefinition
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

    const runsOn = definition.runsOn ?? 'local';
    assertExecutionLocationConstraints({
      runsOn,
      schedule: definition.schedule,
      maxRunBudget: definition.maxRunBudget,
    });

    const job: CronJobDefinition = {
      ...definition,
      runsOn,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    // Save to database
    await this.persistJob(job);

    // Register and start if enabled
    if (job.enabled) {
      this.registerJob(job);
    } else {
      this.jobs.set(job.id, { definition: job });
    }

    await recordCronAutomationCreated(job, this.resolveAutomationRuntime);

    if (job.runsOn === 'cloud') {
      await this.cloudRuntime.addJob(job);
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

    if (updates.runsOn !== undefined && updates.runsOn !== existingJob.definition.runsOn) {
      throw new Error('runsOn is immutable after creation; create a new job to change execution location.');
    }

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
    assertExecutionLocationConstraints(updatedJob);

    // Save to database
    await this.persistJob(updatedJob);

    // Re-register if enabled
    if (updatedJob.enabled) {
      this.registerJob(updatedJob);
    } else {
      this.jobs.set(jobId, { definition: updatedJob });
    }

    syncCronAutomationFromJob(updatedJob, this.resolveAutomationRuntime);

    if (updatedJob.runsOn === 'cloud') {
      await this.cloudRuntime.updateJob(updatedJob);
    }

    return updatedJob;
  }

  /**
   * Delete a job
   */
  async deleteJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (
      job.definition.runsOn === 'cloud'
      && !await this.cloudRuntime.removeJob(job.definition, job.cloudJobId)
    ) {
      return false;
    }

    // Stop cron instance
    if (job.cronInstance) {
      job.cronInstance.stop();
    }

    // Remove from memory
    this.jobs.delete(jobId);
    this.executions.delete(jobId);

    // Remove from database
    await deleteCronJob(jobId);
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
        interrupted: allExecutions.filter((e) => e.status === 'interrupted').length,
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
    const cloudJobId = this.jobs.get(definition.id)?.cloudJobId;
    if (definition.runsOn === 'cloud') {
      this.jobs.set(definition.id, { definition, cloudJobId });
      console.error(`[CronService] Registered cloud job without a local timer: ${definition.name} (${definition.id})`);
      return;
    }
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
      const jitter = computeCronFireJitterMs(schedule.type);
      if (jitter > 0) {
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
      await this.executeJob(definition);
    };

    // 上一次执行还没结束时跳过本次 tick（croner 原生 protect），
    // 防止执行时长超过间隔的循环 agent 任务堆叠并发会话。
    const protect = () => {
      console.error(`[CronService] Job ${id} tick skipped: previous run still in progress`);
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
          // startAt/endAt 是契约既有字段，此前被静默忽略（到期后任务照跑不误）。
          // 交给 croner 原生窗口控制：startAt 前不触发，stopAt 后永久停。
          return new Cron(cronExpr, {
            protect,
            ...(schedule.startAt != null ? { startAt: scheduleBoundToDate(schedule.startAt) } : {}),
            ...(schedule.endAt != null ? { stopAt: scheduleBoundToDate(schedule.endAt) } : {}),
          }, callback);
        }

        case 'cron': {
          return new Cron(
            schedule.expression,
            { timezone: schedule.timezone, protect },
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
      runsOn: definition.runsOn,
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

    // 先落一条 running 记录（maka 护栏自查 A5-④）：不这样做的话，进程在此次
    // 执行期间被杀掉时数据库里不会留下任何痕迹，启动扫描也就无从标记 interrupted。
    await saveCronExecution(execution);

    try {
      if (definition.runsOn === 'cloud') {
        execution.result = await this.cloudRuntime.runJob(definition);
        execution.status = 'completed';
      } else {
        const result = await this.executeAction(definition, definition.action, definition.timeout, execution.id);
        if (isCronAgentActionResult(result)) {
          execution.sessionId = result.sessionId;
        }
        execution.status = 'completed';
        execution.result = result;
        if (definition.action.type !== 'agent') {
          await pushCronResult(definition, result);
        }
      }
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);

      // Handle retries
      if (definition.runsOn === 'local' && definition.maxRetries && execution.retryAttempt < definition.maxRetries) {
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
      await saveCronExecution(execution);

      await recordCronAutomationExecution(definition, execution, this.resolveAutomationRuntime);

      // 连续失败自动停用（maka 护栏自查 A5-⑤）：循环任务连续失败达到阈值后停掉，
      // 防止坏配置/坏凭据的定时 agent 任务无人值守空转烧钱。
      // ponytail: 用内存内 trailing 历史计数，重启后归零；要跨重启严格计数再改查 DB。
      if (
        execution.status === 'failed'
        && definition.scheduleType !== 'at'
        && this.countTrailingFailures(definition.id) >= CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES
      ) {
        console.error(
          `[CronService] Job ${definition.id} auto-disabled after `
          + `${CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES} consecutive failures`,
        );
        await this.updateJob(definition.id, { enabled: false });
      }

      // 定时 agent 任务执行完成后发系统通知，点通知跳到生成的 session
      this.notifyAgentExecution(definition, execution);
    }

    // self-wake：唤醒等这个任务的会话——wake_on 按任务 id 等，wake_on_event 按任务名字等
    // （用户和模型说得出口的是名字，不是 id）。失败不影响本次执行结果。
    void this.notifyWakeOnJobCompleted(definition, execution);

    return execution;
  }

  /**
   * 通知 self-wake 台账：这个任务跑完了。动态 import 避免 cron → services 的加载期耦合。
   *
   * external_event（业务事件监听）任务是例外：它的"完成"是每次轮询 tick，不是业务事件本身——
   * 真正的事件是 <cron_alert>（复用待过目收件箱同一条 skipped 判据，见 recordCronAutomationExecution）。
   * 不按这个判据过滤，wake_on_event 会在安静的轮询 tick 上被反复叫醒，几轮就把每会话 20 次配额烧光，
   * 跟"等业务事件发生"的语义完全对不上。普通任务保持原样：每次跑完都算数。
   */
  private async notifyWakeOnJobCompleted(definition: CronJobDefinition, execution: CronJobExecution): Promise<void> {
    const isExternalWatch = getCronAutomationType(definition) === 'external_event';
    if (isExternalWatch && (execution.status !== 'completed' || isSkippedResult(execution.result))) return;
    try {
      const { getWakeService } = await import('../services/wake/wakeService');
      const service = getWakeService();
      await service.onJobCompleted(definition.id);
      if (definition.name) await service.onEvent(definition.name);
    } catch (err) {
      console.error(`[CronService] wake_on notification failed for ${definition.id}:`, err);
    }
  }

  /** 末尾连续失败次数（内存历史，最新在最后）。 */
  private countTrailingFailures(jobId: string): number {
    const history = this.executions.get(jobId) ?? [];
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].status !== 'failed') break;
      count++;
    }
    return count;
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
        const runStartedAt = Date.now();
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
        // cron/heartbeat 无人值守会话标 async_agent（2026-07-13 拍板）：bash 走
        // ask+forceConfirm，无人应答由 requestPermission 60s 超时 deny 兜底，
        // 与 readOnly 会话档双保险。必须在 sendMessage 前标注。
        orchestrator.setExecutionTopology('async_agent');
        if (cronSession.workingDirectory) {
          tm.setWorkingDirectory(cronSession.id, cronSession.workingDirectory);
        }
        const agentRunOptions: AgentRunOptions = {
          mode: 'normal',
          ...await buildCronAgentRunOptions(action.roleId, cronSession.workingDirectory),
          eventFilter: BACKGROUND_AGENT_EVENT_FILTER,
        };
        const previousSnapshot = ctx?.[CRON_AGENT_SNAPSHOT.CONTEXT_KEY];
        const snapshotTrackingEnabled = ctx?.[CRON_AGENT_SNAPSHOT.ENABLED_KEY] === true;
        // external_event（业务事件监听）任务：无 <cron_alert> = 无新料 = 本次安静。
        // 只对这类任务生效；普通 agent 任务 hasAlert 恒 true，永不被静音。
        const isExternalWatch = Boolean(ctx?.[EXTERNAL_WATCH.CONTEXT_KEY]);
        let hasAlert = !isExternalWatch;

        let result: unknown;
        let finalAssistantText = '';
        let runError: unknown;
        let runFailed = false;
        try {
          try {
            const sendMessage = () => orchestrator.sendMessage(
              buildCronAgentPrompt(action.prompt, previousSnapshot, snapshotTrackingEnabled),
              undefined,
              agentRunOptions,
            );
            result = await runWithCronJobBudget(definition.maxRunBudget, sendMessage);

            const messages = orchestrator.getMessages();
            const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
            finalAssistantText = lastAssistant?.content.trim() ?? '';
            const snapshotMatch = finalAssistantText.match(CRON_AGENT_SNAPSHOT.TAG_PATTERN);
            // 只认标记：解析不到就保留上一次的值。拿整段回答顶替会把叙述性文字
            // 当成状态存下来，下一轮再原样注回提示词。
            const snapshotToPersist = snapshotTrackingEnabled ? snapshotMatch?.[1]?.trim() : undefined;
            if (isExternalWatch) {
              hasAlert = EXTERNAL_WATCH.ALERT_TAG_PATTERN.test(finalAssistantText);
            }
            if (snapshotToPersist) {
              const boundedSnapshot = truncateUtf8Snapshot(snapshotToPersist);
              if (boundedSnapshot.truncated) {
                console.warn(
                  `[CronService] Agent snapshot exceeded ${CRON_AGENT_SNAPSHOT.MAX_BYTES} UTF-8 bytes; truncated`,
                );
              }
              const latestDefinition = this.jobs.get(definition.id)?.definition;
              const latestAction = latestDefinition?.action.type === 'agent'
                ? latestDefinition.action
                : action;
              await this.updateJob(definition.id, {
                action: {
                  ...latestAction,
                  context: {
                    ...latestAction.context,
                    [CRON_AGENT_SNAPSHOT.CONTEXT_KEY]: boundedSnapshot.value,
                  },
                },
              });
            }

            if (action.libraryProjectId) {
              try {
                const { getLibraryService } = await import('../services/library/libraryService');
                if (finalAssistantText) {
                  getLibraryService().archiveText({
                    projectId: action.libraryProjectId,
                    title: definition.name,
                    text: finalAssistantText,
                    tags: ['定稿'],
                    sourceSessionId: cronSession.id,
                    sourceRoleId: action.roleId,
                  });
                  console.error(`[CronService] agent 产出已归档到资料库 project=${action.libraryProjectId}`);
                }
              } catch (archiveError) {
                // 归档是增量能力，失败不拖垮任务（fail-loud 日志，不中断）
                console.warn('[CronService] agent 产出归档失败（任务本身已完成）', archiveError);
              }
            }
          } catch (error) {
            runFailed = true;
            runError = error;
            try {
              const lastAssistant = [...orchestrator.getMessages()]
                .reverse()
                .find((message) => message.role === 'assistant');
              finalAssistantText = lastAssistant?.content.trim() ?? '';
            } catch (messageReadError) {
              console.warn('[CronService] Failed to read partial agent conclusion after cron run failure', messageReadError);
            }
          }
        } finally {
          tm.cleanup(cronSession.id);
        }

        if (action.roleId) {
          try {
            await appendCronAgentExpertThreadReceipt({
              definition,
              roleId: action.roleId,
              cronSessionId: cronSession.id,
              executionId,
              startedAt: runStartedAt,
              succeeded: !runFailed,
              finalAssistantText,
              error: runError,
              automationType: getCronAutomationType(definition),
              workingDirectory: cronSession.workingDirectory,
            });
          } catch (receiptError) {
            console.warn(
              `[CronService] Failed to append named-agent cron receipt; cron result preserved `
              + `(job=${definition.id}, role=${action.roleId}, cronSession=${cronSession.id})`,
              receiptError,
            );
          }
        }
        if (runFailed) throw runError;

        await pushCronResult(definition, result);

        // 无新料的监听运行整成 skipped 形状：复用 isSkippedResult 门，
        // 让它不进待过目收件箱、不写会话回流（快照已在上面照常写回）。
        return {
          agentType: action.agentType,
          prompt: action.prompt,
          result,
          sessionId: cronSession.id,
          ...(isExternalWatch && !hasAlert ? { skipped: true, reason: 'no_new_event' } : {}),
        };
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
        // Internal maintenance: file truth + SQLite mirror are one lifecycle change.
        const { consolidateLightMemory } = await import('../lightMemory/consolidation');
        const { getDatabase } = await import('../services/core/databaseService');
        const report = await consolidateLightMemory({
          dryRun: action.dryRun ?? false,
          db: getDatabase(),
        });
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

  /**
   * 启动时把残留的 running 执行记录标记为 interrupted（maka 护栏自查 A5-④）：
   * 上次进程退出前没跑完的执行会永远停在 running，误导用户以为还在跑。
   * 单条 UPDATE，幂等（重复跑不会二次改动已是 interrupted 的行），不影响启动耗时。
   */
  private async markInterruptedExecutions(): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) return;
      const result = db.prepare(`
        UPDATE cron_executions
        SET status = 'interrupted', completed_at = COALESCE(completed_at, ?)
        WHERE status = 'running'
      `).run(Date.now());
      if (result.changes > 0) {
        console.error(`[CronService] Marked ${result.changes} stale running execution(s) as interrupted`);
      }
    } catch (error) {
      console.error('[CronService] Failed to mark interrupted executions:', error);
    }
  }

  private async loadJobsFromDatabase(): Promise<void> {
    try {
      const db = getDatabase().getDb();
      if (!db) {
        console.error('[CronService] Database not available, starting with empty jobs');
        return;
      }
      const rows = db.prepare('SELECT * FROM cron_jobs').all() as unknown[];
      let loadedCount = 0;
      const now = Date.now();
      for (const row of rows) {
        const job = normalizeCronJobRow(row);
        if (!job) {
          console.error('[CronService] Skipping invalid cron job row');
          continue;
        }

        // 过期的一次性任务停用而不是静默挂起（maka 护栏自查 A5-⑥）：
        // datetime 已过（app 关闭期间错过触发窗）时 croner 永远不会再触发，
        // 旧行为是任务留在 enabled 状态装作还会跑。停用并落库，让状态与事实一致。
        if (job.runsOn === 'local' && job.enabled && job.schedule.type === 'at') {
          const ts = typeof job.schedule.datetime === 'number'
            ? job.schedule.datetime
            : Date.parse(String(job.schedule.datetime));
          if (!Number.isFinite(ts) || ts <= now) {
            const disabled = { ...job, enabled: false, updatedAt: now };
            this.jobs.set(disabled.id, { definition: disabled });
            await this.persistJob(disabled);
            if (Number.isFinite(ts)) {
              await this.recordMissedJob(disabled, ts);
            }
            console.error(`[CronService] One-time job ${job.id} missed its schedule while app was offline; disabled`);
            loadedCount += 1;
            continue;
          }
        }

        if (job.enabled) {
          const cloudJobId = typeof (row as Record<string, unknown>).cloud_job_id === 'string'
            ? (row as Record<string, unknown>).cloud_job_id as string
            : undefined;
          this.jobs.set(job.id, { definition: job, cloudJobId });
          this.registerJob(job);
          const activeJob = this.jobs.get(job.id);
          const previousScheduledAt = activeJob?.cronInstance
            ?.previousRuns(1, new Date(now))[0]
            ?.getTime();
          if (previousScheduledAt != null && previousScheduledAt < now) {
            const lastRunAt = this.loadLastRunAt(job.id) ?? job.createdAt;
            if (lastRunAt < previousScheduledAt) {
              await this.recordMissedJob(job, previousScheduledAt, activeJob?.cronInstance?.nextRun()?.getTime());
            }
          }
        } else {
          const cloudJobId = typeof (row as Record<string, unknown>).cloud_job_id === 'string'
            ? (row as Record<string, unknown>).cloud_job_id as string
            : undefined;
          this.jobs.set(job.id, { definition: job, cloudJobId });
        }
        loadedCount += 1;
      }
      console.error(`[CronService] Loaded ${loadedCount} jobs from database`);
    } catch (error) {
      console.error('[CronService] Failed to load jobs from database:', error);
    }
  }

  private loadLastRunAt(jobId: string): number | undefined {
    try {
      const db = getDatabase().getDb();
      if (!db) return undefined;
      const row = db.prepare(`
        SELECT MAX(started_at) AS last_run_at
        FROM cron_executions
        WHERE job_id = ? AND started_at IS NOT NULL
      `).get(jobId) as { last_run_at?: number | null } | undefined;
      return typeof row?.last_run_at === 'number' ? row.last_run_at : undefined;
    } catch (error) {
      console.error('[CronService] Failed to load cron last-run timestamp:', error);
      return undefined;
    }
  }

  private async recordMissedJob(
    definition: CronJobDefinition,
    scheduledAt: number,
    nextRunAt?: number,
  ): Promise<void> {
    const event: CronMissedEvent = { jobId: definition.id, scheduledAt, reason: 'app-offline' };
    await persistCronMissedTrace(definition, event, nextRunAt);
    getEventBus().publish('system', 'cron.missed', event, { bridgeToRenderer: false });
  }

  private persistJob(job: CronJobDefinition, cloudJobId?: string): Promise<void> {
    return saveCronJob(job, cloudJobId ?? this.jobs.get(job.id)?.cloudJobId);
  }

  private loadExecutionsFromDatabase(jobId: string, limit: number): CronJobExecution[] {
    try {
      const db = getDatabase().getDb();
      if (!db) return [];

      const rows = db.prepare(`
        SELECT cron_executions.*, cron_jobs.runs_on AS runs_on
        FROM cron_executions
        JOIN cron_jobs ON cron_jobs.id = cron_executions.job_id
        WHERE cron_executions.job_id = ?
        ORDER BY cron_executions.scheduled_at DESC
        LIMIT ?
      `).all(jobId, limit) as unknown[];

      return mapCronExecutionRows(rows.reverse());
    } catch (error) {
      console.error('[CronService] Failed to load executions from database:', error);
      return [];
    }
  }

  /**
   * 跨任务执行流（自动化页「运行记录」tab）：全部任务的执行按时间倒序。
   * DB 是权威源——executeJob 开头就落 running 行，无需再并内存态。
   */
  getRecentExecutions(limit: number = 50): CronJobExecution[] {
    try {
      const db = getDatabase().getDb();
      if (!db) return [];
      const rows = db.prepare(`
        SELECT cron_executions.*, cron_jobs.runs_on AS runs_on
        FROM cron_executions
        JOIN cron_jobs ON cron_jobs.id = cron_executions.job_id
        ORDER BY cron_executions.scheduled_at DESC
        LIMIT ?
      `).all(limit) as unknown[];
      return mapCronExecutionRows(rows);
    } catch (error) {
      console.error('[CronService] Failed to load recent executions from database:', error);
      return [];
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
