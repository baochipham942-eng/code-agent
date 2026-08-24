import { v4 as uuidv4 } from 'uuid';
import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import {
  buildCronApiAddParams,
  buildCronApiUpdateParams,
  cloudDeclarationKey,
  cloudRunToExecution,
  CronApiClient,
  type CronApiConfig,
  type CronApiRun,
} from './cronApiClient';

interface CloudJobState {
  definition: CronJobDefinition;
  cloudJobId?: string;
}

/**
 * 云端任务清单的对账周期。ADR-033 决策 5 的「保底 fallback」在当前形态下的真身：
 * 云端 job 一旦在服务端消失（Pod 重建 / 手工清理 / 幂等键被重建），本地这条会永远
 * 停在 enabled 却再也不触发，且无人值守场景零信号。启动时对一次不够——app 一开就是几天。
 */
const RECONCILE_INTERVAL_MS = 60_000;

interface CronCloudRuntimeDeps {
  getJobs: () => Iterable<CloudJobState>;
  persistJob: (definition: CronJobDefinition, cloudJobId: string) => Promise<void>;
  persistExecution: (execution: CronJobExecution) => Promise<void>;
  loadExecutionStatus: (executionId: string) => CronJobExecution['status'] | undefined;
  onCompleted: (
    definition: CronJobDefinition,
    execution: CronJobExecution,
    summary?: string,
  ) => Promise<void>;
  unavailableMessage: () => string;
}

/** 已经过了触发时刻的一次性任务：云端跑完会自动清除，重新注册等于让它再跑一遍。 */
function isSpentOneShot(definition: CronJobDefinition, now: number): boolean {
  const schedule = definition.schedule;
  if (schedule.type !== 'at') return false;
  const ts = typeof schedule.datetime === 'number'
    ? schedule.datetime
    : Date.parse(String(schedule.datetime));
  return !Number.isFinite(ts) || ts <= now;
}

export class CronCloudRuntime {
  private readonly client: CronApiClient;
  private reconcileTimer?: ReturnType<typeof setInterval>;

  constructor(
    getConfig: () => CronApiConfig | undefined,
    private readonly deps: CronCloudRuntimeDeps,
    fetchImpl?: typeof fetch,
  ) {
    this.client = new CronApiClient(getConfig, fetchImpl);
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  start(): void {
    this.client.start((run) => this.projectRun(run));
    this.reconcileTimer ??= setInterval(() => { void this.reconcile(); }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    this.client.stop();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  /**
   * 拿云端现存清单和本地云端任务对账：缺了就重新注册，幂等键还在但 id 变了就把本地指针对回去。
   * 判据是「云端现在有没有这条」，与 removeJob 同一口径——不认报错文案。
   */
  async reconcile(): Promise<void> {
    if (!this.client.isConfigured()) return;
    const jobs = [...this.deps.getJobs()]
      .filter((job) => job.definition.runsOn === 'cloud' && job.definition.enabled);
    if (jobs.length === 0) return;

    let remoteJobs: Array<{ id: string; declarationKey?: string }>;
    try {
      remoteJobs = await this.client.listJobs();
    } catch (error) {
      // 拉不到清单＝网络/服务瞬时不可用，下一轮再对。
      // 🚫 不在这里给每条任务记一次失败：断网时会刷屏，把真正的「云端丢了这条」淹掉。
      console.warn(
        '[CronService] Cloud cron reconcile skipped:',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const now = Date.now();
    for (const job of jobs) {
      const declarationKey = cloudDeclarationKey(job.definition.id);
      const match = remoteJobs.find(
        (remote) => (job.cloudJobId != null && remote.id === job.cloudJobId)
          || remote.declarationKey === declarationKey,
      );
      if (match) {
        if (match.id !== job.cloudJobId) {
          job.cloudJobId = match.id;
          await this.deps.persistJob(job.definition, match.id);
        }
        continue;
      }
      if (isSpentOneShot(job.definition, now)) continue;
      console.warn(`[CronService] Cloud job ${job.definition.id} is gone on the server; re-registering.`);
      await this.addJob(job.definition);
    }
  }

  async addJob(
    definition: CronJobDefinition,
    recordFailure = true,
  ): Promise<string | undefined> {
    try {
      const remoteJobId = await this.client.addJob(buildCronApiAddParams(definition));
      const active = [...this.deps.getJobs()].find((job) => job.definition.id === definition.id);
      if (active) active.cloudJobId = remoteJobId;
      await this.deps.persistJob(definition, remoteJobId);
      return remoteJobId;
    } catch (error) {
      if (!recordFailure) throw error;
      await this.recordFailure(definition, error);
      return undefined;
    }
  }

  async updateJob(definition: CronJobDefinition): Promise<void> {
    const remoteJobId = [...this.deps.getJobs()]
      .find((job) => job.definition.id === definition.id)?.cloudJobId;
    if (!remoteJobId) {
      await this.addJob(definition);
      return;
    }
    try {
      await this.client.updateJob(buildCronApiUpdateParams(definition, remoteJobId));
    } catch (error) {
      await this.recordFailure(definition, error);
    }
  }

  async removeJob(definition: CronJobDefinition, knownRemoteJobId?: string): Promise<boolean> {
    try {
      // 判据是「云端现在还有没有这条」，不是「删除请求报了什么错」——一次性任务跑完会被
      // 云端自动清掉，此时 remove 报 not found 是正常状态而非失败。当成失败会让本地那条
      // 永远删不掉（deleteJob 只有云端删成功才往下走），用户点删除毫无反应。
      const declarationKey = cloudDeclarationKey(definition.id);
      const remoteJobId = (await this.client.listJobs())
        .find((job) => job.id === knownRemoteJobId || job.declarationKey === declarationKey)?.id;
      if (!remoteJobId) return true;
      await this.client.removeJob(remoteJobId);
      return true;
    } catch (error) {
      await this.recordFailure(definition, error);
      return false;
    }
  }

  async runJob(definition: CronJobDefinition): Promise<unknown> {
    try {
      const remoteJobId = [...this.deps.getJobs()]
        .find((job) => job.definition.id === definition.id)?.cloudJobId
        ?? await this.addJob(definition, false);
      if (!remoteJobId) throw new Error('Cloud cron job could not be synchronized.');
      return await this.client.runJob(remoteJobId);
    } catch (error) {
      throw new Error(this.deps.unavailableMessage(), { cause: error });
    }
  }

  private async recordFailure(definition: CronJobDefinition, cause: unknown): Promise<void> {
    const now = Date.now();
    await this.deps.persistExecution({
      id: uuidv4(),
      jobId: definition.id,
      runsOn: 'cloud',
      status: 'failed',
      scheduledAt: now,
      startedAt: now,
      completedAt: now,
      duration: 0,
      error: this.deps.unavailableMessage(),
      retryAttempt: 0,
    });
    console.warn(
      `[CronService] Cloud job operation failed for ${definition.id}:`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  private async projectRun(run: CronApiRun): Promise<void> {
    const active = [...this.deps.getJobs()].find((job) => job.cloudJobId === run.jobId);
    if (!active) return;
    const execution = cloudRunToExecution(run, active.definition.id);
    const status = this.deps.loadExecutionStatus(execution.id);
    if (status && status !== 'running' && status !== 'pending') return;
    await this.deps.persistExecution(execution);
    if (run.action === 'finished') {
      await this.deps.onCompleted(active.definition, execution, run.summary);
    }
  }
}
