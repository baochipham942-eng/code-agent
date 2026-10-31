import { IPC_DOMAINS } from '@shared/ipc';
import type { CronEventActionMode, CronEventDecision, CronGroupListenCheck, CronMailSourcesResult } from '@shared/contract/cron';
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

/** 一次性展示的 webhook 链接；调用方展示后即丢弃，不得持久化。 */
export interface CronWebhookHookSecret {
  url: string;
  token: string;
}

/** hook 注册/轮换失败：code 可区分「云端未配置」，message 为主机原文（不含密钥）。 */
export class CronHookError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'CronHookError';
  }
}

async function invokeHookAction(action: 'registerWebhookHook' | 'rotateWebhookHook', jobId: string): Promise<CronWebhookHookSecret> {
  const response = await window.domainAPI?.invoke<CronWebhookHookSecret>(IPC_DOMAINS.CRON, action, { jobId });
  if (!response?.success || !response.data) {
    throw new CronHookError(response?.error?.message || `cron:${action} failed`, response?.error?.code);
  }
  return response.data;
}

export const cronClient = {
  registerWebhookHook(jobId: string) {
    return invokeHookAction('registerWebhookHook', jobId);
  },

  rotateWebhookHook(jobId: string) {
    return invokeHookAction('rotateWebhookHook', jobId);
  },

  /** 云端地址/令牌保存后调用：不重启即启动事件流（幂等）。 */
  ensureCloudStream() {
    return invokeCron<void>('ensureCloudStream');
  },

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

  triggerJob(jobId: string) {
    return invokeCron<CronJobExecution | null>('triggerJob', { jobId });
  },

  getExecutions(jobId: string, limit = 20) {
    return invokeCron<CronJobExecution[]>('getExecutions', { jobId, limit });
  },

  /** 事件自动化最近的逐事件决策（新的在前；N-TRIGGER-OBSERVE-MODE）。 */
  getEventDecisions(jobId: string, limit = 50) {
    return invokeCron<CronEventDecision[]>('getEventDecisions', { jobId, limit });
  },

  /** 最近一次执行档切换（详情页的变更记录行；返修⑥）。 */
  getEventActionModeChange(jobId: string) {
    return invokeCron<{ from: 'observe' | 'auto'; to: 'observe' | 'auto'; at: number } | null>(
      'getEventActionModeChange', { jobId },
    );
  },

  /** 切换事件自动化执行档：唯一能切到 auto 的入口（UI 侧必须先过确认弹窗）。 */
  setEventActionMode(jobId: string, mode: CronEventActionMode) {
    return invokeCron<CronJobDefinition | null>('setEventActionMode', { jobId, mode });
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
