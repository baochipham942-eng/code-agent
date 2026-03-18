import { IPC_DOMAINS } from '@shared/ipc';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronServiceStats,
} from '@shared/types';

export type CronJobFilter = {
  enabled?: boolean;
  tags?: string[];
};

export type CreateCronJobInput = Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateCronJobInput = Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>;

async function invokeCron<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.CRON, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `cron:${action} failed`);
  }
  return response.data as T;
}

export const cronClient = {
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

  triggerJob(jobId: string) {
    return invokeCron<CronJobExecution | null>('triggerJob', { jobId });
  },

  getExecutions(jobId: string, limit = 20) {
    return invokeCron<CronJobExecution[]>('getExecutions', { jobId, limit });
  },

  getStats() {
    return invokeCron<CronServiceStats>('getStats');
  },

  generateFromPrompt(prompt: string) {
    return invokeCron<Record<string, unknown>>('generateFromPrompt', { prompt });
  },
};

export default cronClient;
