import { UNATTENDED_TRUST_NOTICE } from '../../shared/unattendedTrust';
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
  CronExecutionTrigger,
  CronServiceStats,
  CronMissedEvent,
  CronMissedReason,
  CreateCronJobDefinition,
} from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import { getConfigService } from '../services/core/configService';
import type { Disposable } from '../services/serviceRegistry';
import { getServiceRegistry } from '../services/serviceRegistry';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
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
  formatCronAgentSessionTitle,
  isCronAgentActionResult,
  getCronAgentSessionType,
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
import { parseCronRunDigest } from '../../shared/cronRunDigest';
import { beginArtifactRefresh, finishArtifactRefresh } from './artifactStandingRefresh';
import {
  assertExecutionLocationConstraints,
  computeCronFireJitterMs,
  decideOneTimeJobStartup,
  intervalToCron,
  runWithCronJobBudget,
  scheduleBoundToDate,
} from './cronExecutionPolicy';
import { CronCloudRuntime } from './cronCloudRuntime';
import { CronEventTrigger, assertEventScheduleConstraints, hasExplicitChatListenBinding } from './cronEventTrigger';
import { setChannelListenResolver } from '../channels/channelListenRegistry';
import {
  deleteCronJob,
  loadCronExecutionStatus,
  loadCronExecutionsByJob,
  loadCronLastRunAt,
  loadRecentCronExecutions,
  markInterruptedCronExecutions,
  saveCronExecution,
  saveCronJob,
  upsertCronExecutionInMemory,
} from './cronPersistence';
import { deliverCronResultToChannel } from './cronResultDelivery';
import { rearmCronRunLimit, settleCronRunLimit } from './cronRunLimit';
import {
  adoptFailedAgentSession,
  classifyCronFailure,
  countTrailingCronFailures,
  cronRetryBackoffMs,
  CronFailureNoticeGate,
  notifyCronAgentExecution,
  notifyCronJobDisabled,
} from './cronFailurePolicy';
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
  /** 'event' 调度的本地事件源（通道入站消息 → 合批 → executeJob）。 */
  private cronEventTrigger?: CronEventTrigger;
  private readonly failureNoticeGate = new CronFailureNoticeGate();
  /** 正在执行（含退避重试链）的 jobId：系统侧触发互斥，见 runScheduledJob。 */
  private readonly inFlightJobIds = new Set<string>();
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
        await this.deliverCronResult(definition, summary, execution.id);
        notifyCronAgentExecution(definition, execution, this.failureNoticeGate);
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
    await markInterruptedCronExecutions();

    // Load jobs from database
    await this.loadJobsFromDatabase();
    await this.cloudRuntime.reconcile();

    if (this.cloudRuntime.isConfigured()) {
      this.cloudRuntime.start();
    }

    this.cronEventTrigger = new CronEventTrigger({
      host: {
        getJobDefinitions: () => this.listJobs(),
        isJobInFlight: (jobId) => this.inFlightJobIds.has(jobId),
        executeEventJob: (definition, trigger, payloadBlock) =>
          this.executeJob(definition, trigger, payloadBlock),
      },
    });
    this.cronEventTrigger.start();

    // 群监听绑定解析器：未 @ 的群消息按 hasExplicitChatListenBinding 判显式 (accountId, chatId) 绑定。
    setChannelListenResolver((accountId, chatId) => hasExplicitChatListenBinding(this.listJobs(), accountId, chatId));

    this.isInitialized = true;
    console.error('[CronService] Initialized');
  }

  async shutdown(): Promise<void> {
    this.cronEventTrigger?.dispose();
    this.cronEventTrigger = undefined;
    setChannelListenResolver(undefined);
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
    assertExecutionLocationConstraints({ ...definition, runsOn });
    assertEventScheduleConstraints({ ...definition, runsOn });

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
    // 重新启用已停用任务：运行计数清零、摘掉停用原因（N-CRON-BUDGET-EXPOSE）；只改 maxRuns 不动计数。
    if (updates.enabled === true && !existingJob.definition.enabled) rearmCronRunLimit(updatedJob);
    assertSupportedEveryScheduleUnit(updatedJob.schedule);
    assertExecutionLocationConstraints(updatedJob);
    assertEventScheduleConstraints(updatedJob);

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

    const persisted = loadCronExecutionsByJob(jobId, limit);
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
      const jitter = computeCronFireJitterMs(schedule);
      if (jitter > 0) {
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
      // jitter 窗口最长 15min：等待结束必须按 jobId 重取当前 definition（见 runScheduledJob），
      // 不能拿这个闭包里注册时的旧 definition——等待期间被停用/删除/编辑过的任务
      // 照跑旧定义会产生模型费用、改过的 prompt 不生效（R2 审查 Important-3）。
      await this.runScheduledJob(id);
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
          const cronExpr = intervalToCron(schedule.interval, schedule.unit, id);
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

        case 'event': {
          // 事件任务没有 croner 实例也没有 nextRunAt：由 CronEventTrigger 按入站消息触发。
          return undefined;
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

  /**
   * 系统侧执行入口（croner tick 走完 jitter 等待后 / misfire 宽限窗补跑）：
   * 执行前按 jobId 重取**当前**定义，不存在或已停用则跳过并留痕（不是这次执行的失败，
   * 不计连败、不发失败告警）——jitter 窗口最长 15min，等待期间任务可能已被停用/删除，
   * 拿注册时闭包里的旧 definition 照样执行会对已停任务产生模型费用（R2 审查 Important-3）。
   * 手动 triggerJob 不走这里：用户点「立即运行」就该立即运行。
   */
  private async runScheduledJob(jobId: string): Promise<void> {
    const current = this.jobs.get(jobId)?.definition;
    if (!current) {
      console.warn(`[CronService] Job ${jobId} skipped: deleted while waiting to fire`);
      return;
    }
    if (!current.enabled) {
      console.warn(`[CronService] Job ${jobId} skipped: disabled while waiting to fire`);
      return;
    }
    // 上一趟（含宽限窗补跑、上一 tick）还没结束就跳过本趟：croner 原生 protect 只看它
    // 自己的回调，直接 executeJob 的补跑会绕过它，与紧接的正常 tick 并发堆会话（R2 审查 Nit-3）。
    if (this.inFlightJobIds.has(jobId)) {
      console.error(`[CronService] Job ${jobId} run skipped: previous run still in progress`);
      return;
    }
    await this.executeJob(current);
  }

  private async executeJob(
    definition: CronJobDefinition,
    trigger?: CronExecutionTrigger,
    eventPayloadBlock?: string,
  ): Promise<CronJobExecution> {
    const execution: CronJobExecution = {
      id: uuidv4(),
      jobId: definition.id,
      runsOn: definition.runsOn,
      status: 'running',
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      retryAttempt: 0,
      trigger,
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

    // in-flight 标记从执行开始持有到 finally 收尾（含 catch 里的整条退避重试链），
    // 供 runScheduledJob 做系统侧互斥；放在首条 save 之后，异常时不留悬挂标记。
    this.inFlightJobIds.add(definition.id);

    try {
      if (definition.runsOn === 'cloud') {
        execution.result = await this.cloudRuntime.runJob(definition);
        execution.status = 'completed';
      } else {
        const result = await this.executeAction(definition, definition.action, definition.timeout, execution.id, eventPayloadBlock);
        if (isCronAgentActionResult(result)) {
          execution.sessionId = result.sessionId;
        }
        execution.status = 'completed';
        execution.result = result;
        if (definition.action.type !== 'agent') {
          await this.deliverCronResult(definition, result, execution.id);
        }
      }
    } catch (error) {
      execution.error = error instanceof Error ? error.message : String(error);
      adoptFailedAgentSession(execution, error);
      const failureKind = classifyCronFailure(execution.error);

      if (failureKind === 'capacity-wait') {
        // 排队等容量/等并发槽时被中断：不是这次任务的失败，不计失败、不烧重试次数，
        // 等下一个正常 tick（Cline 实付回归：capacity waits 被当成重试次数烧光）。
        execution.status = 'cancelled';
        console.warn(
          `[CronService] Job ${definition.id} run interrupted while queued for capacity; not counted as failure`,
        );
      } else if (failureKind === 'permanent') {
        // 配置/鉴权类确定性失败：重试无用，直接 failed；停用+告知在 finally 统一处理。
        execution.status = 'failed';
        console.error(
          `[CronService] Job ${definition.id} failed permanently (retry is useless): ${execution.error}`,
        );
      } else {
        // transient：退避重试（延迟序列见 retryExecution，替换旧的固定 5s 兜底）
        execution.status = 'failed';
        if (definition.runsOn === 'local' && definition.maxRetries && execution.retryAttempt < definition.maxRetries) {
          await this.retryExecution(definition, execution, eventPayloadBlock);
        }
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

      // 失败停用分档（N-CRON-RESILIENCE）：permanent 首次即停用（重试无用）；
      // transient 连败达到阈值（退避重试已烧尽）后最终停用。两条路都发带出处的通知。
      // ponytail: 用内存内 trailing 历史计数，重启后归零；要跨重启严格计数再改查 DB。
      let disableNotified = false;
      if (execution.status === 'failed' && definition.scheduleType !== 'at') {
        const finalKind = classifyCronFailure(execution.error);
        if (finalKind === 'permanent') {
          console.error(
            `[CronService] Job ${definition.id} auto-disabled after permanent failure: ${execution.error}`,
          );
          await this.updateJob(definition.id, { enabled: false });
          notifyCronJobDisabled(definition, execution, 'permanent');
          disableNotified = true;
        } else if (countTrailingCronFailures(this.executions.get(definition.id) ?? []) >= CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[CronService] Job ${definition.id} auto-disabled after `
            + `${CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES} consecutive failures`,
          );
          await this.updateJob(definition.id, { enabled: false });
          notifyCronJobDisabled(definition, execution, 'consecutive');
          disableNotified = true;
        }
      }

      // 次数上限结算（N-CRON-BUDGET-EXPOSE，实现见 cronRunLimit.ts）：排在失败停用之后，同趟不重复停用；
      // 记数走窄写且整体已兜底，抛错不会逃出 finally 卡死 in-flight（PR#2208 ai-review Important）。
      // （hooks 压行：本文件贴 max-lines 红线，格式还原 #2208 R4 Nit-3 需要这两行额度。）
      disableNotified = await settleCronRunLimit(definition.id, execution, disableNotified, {
        getDefinition: (jobId) => this.jobs.get(jobId)?.definition, updateJob: (jobId, updates) => this.updateJob(jobId, updates) });

      // 定时 agent 任务执行完成后发系统通知，点通知跳到生成的 session。
      // 停用的那一趟只发停用通知（已含最后错误与出路）——同一笔失败再叠一条
      // 失败告警就是一次失败两条通知（R2 审查 Nit-1）。
      if (!disableNotified) {
        notifyCronAgentExecution(definition, execution, this.failureNoticeGate);
      }

      this.inFlightJobIds.delete(definition.id);
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

  private async executeAction(
    definition: CronJobDefinition,
    action: CronJobAction,
    timeout?: number,
    executionId?: string,
    eventPayloadBlock?: string
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
        throw new Error('unsupported_action');
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
          inputSource: 'automation',
          disableAutoAgent: true,
          mode: 'normal',
          ...await buildCronAgentRunOptions(action.roleId, cronSession.workingDirectory),
          eventFilter: BACKGROUND_AGENT_EVENT_FILTER,
        };
        agentRunOptions.systemInstructions = [UNATTENDED_TRUST_NOTICE];
        const previousSnapshot = ctx?.[CRON_AGENT_SNAPSHOT.CONTEXT_KEY];
        const snapshotTrackingEnabled = ctx?.[CRON_AGENT_SNAPSHOT.ENABLED_KEY] === true;
        // external_event（业务事件监听）任务：无 <cron_alert> = 无新料 = 本次安静。
        // 只对这类任务生效；普通 agent 任务 hasAlert 恒 true，永不被静音。
        const isExternalWatch = Boolean(ctx?.[EXTERNAL_WATCH.CONTEXT_KEY]);
        let hasAlert = !isExternalWatch;

        let result: unknown; let finalAssistantText = '';
        let runError: unknown; let runFailed = false;
        // 常设刷新（metadata.artifactRefresh）：跑前建快照记基线；非刷新任务返回 undefined 零扰动
        const artifactRefresh = beginArtifactRefresh(definition);
        try {
          try {
            // 事件触发时通道载荷只以 untrusted 定界块追加在 prompt 尾部，并给该条
            // 用户消息标 memoryTainted（跳过自动记忆写）。调度触发的 run 字节不变。
            const sendMessage = () => orchestrator.sendMessage(
              buildCronAgentPrompt(action.prompt, previousSnapshot, snapshotTrackingEnabled)
                + (eventPayloadBlock === undefined ? '' : `\n\n${eventPayloadBlock}`),
              undefined,
              agentRunOptions,
              eventPayloadBlock === undefined ? undefined : { memoryTainted: true },
            );
            result = await runWithCronJobBudget(definition.maxRunBudget, sendMessage);
            const unattendedTimeout = (await import('../agent/unattendedApprovalTerminal')).takeUnattendedApprovalTimeout(cronSession.id);
            if (unattendedTimeout) throw new Error(unattendedTimeout);

            finalAssistantText = [...orchestrator.getMessages()].reverse().find((message) => message.role === 'assistant')?.content.trim() ?? '';
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
            runError = ((code: string | undefined) => code ? new Error(code) : error)((await import('../agent/unattendedApprovalTerminal')).takeUnattendedApprovalTimeout(cronSession.id));
            try {
              const lastAssistant = [...orchestrator.getMessages()].reverse().find((message) => message.role === 'assistant');
              finalAssistantText = lastAssistant?.content.trim() ?? '';
            } catch (messageReadError) {
              console.warn('[CronService] Failed to read partial agent conclusion after cron run failure', messageReadError);
            }
          }
        } finally {
          tm.cleanup(cronSession.id);
        }

        // runFailed 已知即结算常设刷新：成功走校验+留版（有标注则清），失败回滚快照并标注
        if (artifactRefresh) await finishArtifactRefresh(artifactRefresh, { runFailed, error: runError, updateJob: (u) => this.updateJob(definition.id, u) });

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
        if (runFailed) {
          // 失败也把 cron 会话带出去（挂在 error 上）：失败告警（去重+冷却后）要能
          // 点击跳到这个半成品会话，执行台账也能关联到它。成功路径走 result.sessionId。
          if (runError instanceof Error && !('cronSessionId' in runError)) {
            (runError as Error & { cronSessionId?: string }).cronSessionId = cronSession.id;
          }
          throw runError;
        }

        // 无新料的监听轮不投递（FB-239）：skipped 判定必须先于推送，
        // 否则安静轮照样把「没有更新」推到通道，跟 skipped 语义无进收件箱自相矛盾。
        const quietWatchRound = isExternalWatch && !hasAlert;
        if (!quietWatchRound) {
          // 推送正文必须是最后一条 assistant 正文：orchestrator.sendMessage 是 Promise<void>，
          // result 恒 undefined，推它等于永远不推（PR#2060 ai-review Important）。
          await this.deliverCronResult(definition, finalAssistantText || result, executionId);
        }

        // 无新料的监听运行整成 skipped 形状：复用 isSkippedResult 门，
        // 让它不进待过目收件箱、不写会话回流（快照已在上面照常写回）。
        return {
          agentType: action.agentType,
          prompt: action.prompt,
          result,
          sessionId: cronSession.id,
          digest: parseCronRunDigest(finalAssistantText),
          ...(quietWatchRound ? { skipped: true, reason: 'no_new_event' } : {}),
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
        throw new Error('unsupported_action');
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
    const sessionType = getCronAgentSessionType(action);
    const originKind = sessionType === 'heartbeat' ? 'heartbeat' : 'cron';

    return sessionManager.createSession({
      title: formatCronAgentSessionTitle(definition, sessionType),
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
    execution: CronJobExecution,
    eventPayloadBlock?: string
  ): Promise<void> {
    // 指数退避（N-CRON-RESILIENCE）：第 n 次重试前等待 min(BASE×FACTOR^(n-1), MAX)，
    // 序列 30s→60s→120s→…封顶 15min，替换旧的固定 5s 兜底；显式 retryDelay 仍优先。
    const delay = definition.retryDelay ?? cronRetryBackoffMs(execution.retryAttempt + 1);

    await new Promise((resolve) => setTimeout(resolve, delay));

    // 不变量 A（R3）：等待后再执行——按 jobId 重取当前定义。等待期间（最长 15min）任务
    // 可能已被停用/删除：拿闭包旧定义照跑是对已停任务再花一笔执行成本。中止重试链，
    // 终态 cancelled（不是这次执行的失败，不计连败；最后一次真实失败仍留在 execution.error）。
    const current = this.jobs.get(definition.id)?.definition;
    // 只拦「等待期间才被停用」：手动运行一个本来就停用的任务，重试照常（PR#2143 复审 R3）。
    if (!current || (definition.enabled && !current.enabled)) {
      console.warn(`[CronService] Job ${definition.id} retry skipped: job ${current ? 'disabled' : 'deleted'} while waiting to retry`);
      execution.status = 'cancelled';
      return;
    }

    execution.retryAttempt++;
    execution.status = 'running';
    execution.startedAt = Date.now();

    try {
      const result = await this.executeAction(current, current.action, current.timeout, execution.id, eventPayloadBlock);
      if (isCronAgentActionResult(result)) {
        execution.sessionId = result.sessionId;
      }
      execution.status = 'completed';
      execution.result = result;
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);
      adoptFailedAgentSession(execution, error);

      // permanent：确定性失败，烧掉剩余重试毫无意义，停在这里等 finally 的停用档。
      if (classifyCronFailure(execution.error) === 'permanent') return;

      // Continue retrying if we haven't reached the limit
      if (execution.retryAttempt < (current.maxRetries || 0)) {
        await this.retryExecution(current, execution, eventPayloadBlock);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Database Operations
  // --------------------------------------------------------------------------

  /** 投递与失败留痕的实现已拆到 cronResultDelivery.ts（含 FB-239 字面去重写回）。 */
  private async deliverCronResult(definition: CronJobDefinition, result: unknown, executionId?: string): Promise<void> {
    await deliverCronResultToChannel(definition, result, this.executions, executionId, {
      getLatestDefinition: (jobId) => this.jobs.get(jobId)?.definition,
      persistAction: (jobId, action) => this.updateJob(jobId, { action }),
    });
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
        // misfire 宽限窗（N-CRON-RESILIENCE）：刚错过不久（≤MISFIRE_GRACE_MS）且没跑过的照跑，
        // 覆盖重启/升级/短暂崩溃的空档；该趟已开始过（跑一半崩溃）不整趟重跑（R3 不变量 B，
        // 判据见 decideOneTimeJobStartup）；超窗才判离线错过停用。
        if (job.runsOn === 'local' && job.enabled && job.schedule.type === 'at') {
          const decision = decideOneTimeJobStartup(job, now, loadCronLastRunAt(job.id));
          if (decision.kind !== 'register') {
            if (decision.kind === 'catch-up') {
              this.jobs.set(job.id, { definition: job });
              console.error(
                `[CronService] One-time job ${job.id} due ${new Date(decision.dueAt).toISOString()} `
                + 'within misfire grace window; running it now',
              );
              void this.runScheduledJob(job.id).catch((err) => {
                console.error(`[CronService] Grace-window catch-up failed for job ${job.id}:`, err);
              });
            } else {
              const disabled = { ...job, enabled: false, updatedAt: now };
              this.jobs.set(disabled.id, { definition: disabled });
              await this.persistJob(disabled);
              if (decision.dueAt != null) {
                await this.recordMissedJob(disabled, decision.dueAt, undefined, decision.missedReason);
              }
              console.error(`[CronService] One-time job ${job.id} ${decision.alreadyStarted ? 'already started before restart (interrupted mid-run); disabled without re-running' : 'missed its schedule while app was offline; disabled'}`);
            }
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
            const lastRunAt = loadCronLastRunAt(job.id) ?? job.createdAt;
            if (lastRunAt < previousScheduledAt) {
              // misfire 宽限窗（N-CRON-RESILIENCE）：窗内照跑（补这一趟），
              // 超窗判离线错过、标 skipped 不补跑（保留既有 recordMissedJob 语义）。
              if (now - previousScheduledAt <= CRON_GUARDRAILS.MISFIRE_GRACE_MS) {
                console.error(
                  `[CronService] Job ${job.id} missed tick ${new Date(previousScheduledAt).toISOString()} `
                  + 'within grace window; running catch-up',
                );
                void this.runScheduledJob(job.id).catch((err) => {
                  console.error(`[CronService] Grace-window catch-up failed for job ${job.id}:`, err);
                });
              } else {
                await this.recordMissedJob(job, previousScheduledAt, activeJob?.cronInstance?.nextRun()?.getTime());
              }
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

  private async recordMissedJob(
    definition: CronJobDefinition,
    scheduledAt: number,
    nextRunAt?: number,
    missedReason: CronMissedReason = 'app-offline',
  ): Promise<void> {
    const event: CronMissedEvent = { jobId: definition.id, scheduledAt, reason: missedReason };
    await persistCronMissedTrace(definition, event, nextRunAt);
    getEventBus().publish('system', 'cron.missed', event, { bridgeToRenderer: false });
  }

  private persistJob(job: CronJobDefinition, cloudJobId?: string): Promise<void> {
    return saveCronJob(job, cloudJobId ?? this.jobs.get(job.id)?.cloudJobId);
  }

  /**
   * 跨任务执行流（自动化页「运行记录」tab）：全部任务的执行按时间倒序。
   * DB 是权威源——executeJob 开头就落 running 行，无需再并内存态。
   */
  getRecentExecutions(limit: number = 50): CronJobExecution[] {
    return loadRecentCronExecutions(limit);
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
