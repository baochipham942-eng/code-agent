import { IPC_DOMAINS } from '@shared/ipc';
import type { CronGroupListenCheck, CronMailSourcesResult } from '@shared/contract/cron';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronServiceStats,
  CreateCronJobDefinition,
} from '@shared/contract';

export type CronJobFilter = {
  enabled?: boolean;
  tags?: string[];
};

export type CreateCronJobInput = CreateCronJobDefinition;
export type UpdateCronJobInput = Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>;

async function invokeCron<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.CRON, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `cron:${action} failed`);
  }
  return response.data as T;
}

export const cronClient = {
  getGroupListenCheck(jobId: string) {
    return invokeCron<CronGroupListenCheck | null>('getGroupListenCheck', { jobId });
  },

  startGroupListenCheck(jobId: string) {
    return invokeCron<CronGroupListenCheck | null>('startGroupListenCheck', { jobId });
  },
  listJobs(filter?: CronJobFilter) {
    return invokeCron<CronJobDefinition[]>('listJobs', { filter });
  },

  createJob(input: CreateCronJobInput) {
    return invokeCron<CronJobDefinition>('createJob', input);
  },

  updateJob(jobId: string, updates: UpdateCronJobInput) {
    return invokeCron<CronJobDefinition | null>('updateJob', { jobId, updates });
  },

  deleteJob(jobId: string) {
    return invokeCron<boolean>('deleteJob', { jobId });
  },

  grantLoginPassThrough(jobId: string, siteOrigin: string) {
    return invokeCron<CronJobDefinition | null>('grantLoginPassThrough', { jobId, siteOrigin });
  },

  /** 写授权（任务详情面板一键同意）：host 解析工作文件夹并写入 metadata.writeGrantRoot。 */
  grantWriteScope(jobId: string) {
    return invokeCron<CronJobDefinition | null>('grantWriteScope', { jobId });
  },

  revokeWriteScope(jobId: string) {
    return invokeCron<CronJobDefinition | null>('revokeWriteScope', { jobId });
  },

  triggerJob(jobId: string) {
    return invokeCron<CronJobExecution | null>('triggerJob', { jobId });
  },

  getExecutions(jobId: string, limit = 20) {
    return invokeCron<CronJobExecution[]>('getExecutions', { jobId, limit });
  },

  /** 跨任务执行流（运行记录 tab）：全部任务的执行按时间倒序 */
  getRecentExecutions(limit = 50) {
    return invokeCron<CronJobExecution[]>('getRecentExecutions', { limit });
  },

  getStats() {
    return invokeCron<CronServiceStats>('getStats');
  },

  /** 「新邮件」触发源的账号/邮箱目录（含可用性 reason 分类；编辑器与 /schedule 确认卡共用）。 */
  listMailSources() {
    return invokeCron<CronMailSourcesResult>('listMailSources');
  },

  generateFromPrompt(prompt: string) {
    return invokeCron<Record<string, unknown>>('generateFromPrompt', { prompt });
  },
};

export default cronClient;
