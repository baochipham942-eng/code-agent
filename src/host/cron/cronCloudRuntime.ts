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

export class CronCloudRuntime {
  private readonly client: CronApiClient;

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
  }

  stop(): void {
    this.client.stop();
  }

  async reconcile(): Promise<void> {
    for (const job of this.deps.getJobs()) {
      if (job.definition.runsOn === 'cloud' && !job.cloudJobId) {
        await this.addJob(job.definition);
      }
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
