import { create } from 'zustand';
import type { CronEventActionMode } from '@shared/contract/cron';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronServiceStats,
} from '@shared/contract';
import { isRoleBoundCronJob } from '@shared/cronRoleBinding';
import { isWebhookCronJob } from '@shared/cronWebhookJob';
import {
  cronClient,
  type CreateCronJobInput,
  type UpdateCronJobInput,
} from '../services/cronClient';
import { createLogger } from '../utils/logger';

const logger = createLogger('CronStore');

export type CronJobFilterMode = 'all' | 'enabled' | 'disabled';

interface CronState {
  jobs: CronJobDefinition[];
  stats: CronServiceStats | null;
  latestExecutions: Record<string, CronJobExecution | null>;
  executionsByJobId: Record<string, CronJobExecution[]>;
  /** 跨任务执行流（运行记录 tab），按时间倒序 */
  recentExecutions: CronJobExecution[];
  selectedJobId: string | null;
  filterMode: CronJobFilterMode;
  searchQuery: string;
  isLoading: boolean;
  isEditorOpen: boolean;
  editingJobId: string | null;
  copyingJobId: string | null;
  error: string | null;

  setFilterMode: (mode: CronJobFilterMode) => void;
  setSearchQuery: (query: string) => void;
  selectJob: (jobId: string | null) => void;
  openCreateEditor: () => void;
  openEditEditor: (jobId: string) => void;
  openCopyEditor: (jobId: string) => void;
  closeEditor: () => void;
  loadJobs: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadExecutions: (jobId: string, limit?: number) => Promise<void>;
  loadRecentExecutions: (limit?: number) => Promise<void>;
  /** 有 running 执行时由面板轮询调用：一次请求同时校正「运行记录」流与各任务最近一次执行。 */
  syncRunningExecutions: () => Promise<void>;
  refresh: () => Promise<void>;
  createJob: (input: CreateCronJobInput) => Promise<CronJobDefinition>;
  updateJob: (jobId: string, updates: UpdateCronJobInput) => Promise<CronJobDefinition | null>;
  deleteJob: (jobId: string) => Promise<boolean>;
  triggerJob: (jobId: string) => Promise<CronJobExecution | null>;
  /** 事件自动化执行档切换（调用方负责先弹确认框）；成功后刷新任务表。 */
  setEventActionMode: (jobId: string, mode: CronEventActionMode) => Promise<CronJobDefinition | null>;
}

async function loadLatestExecution(jobId: string): Promise<CronJobExecution | null> {
  try {
    const executions = await cronClient.getExecutions(jobId, 1);
    return executions[0] || null;
  } catch (error) {
    logger.warn('Failed to load latest cron execution', { jobId, error });
    return null;
  }
}

export const useCronStore = create<CronState>()((set, get) => ({
  jobs: [],
  stats: null,
  latestExecutions: {},
  executionsByJobId: {},
  recentExecutions: [],
  selectedJobId: null,
  filterMode: 'all',
  searchQuery: '',
  isLoading: false,
  isEditorOpen: false,
  editingJobId: null,
  copyingJobId: null,
  error: null,

  setFilterMode: (mode) => set({ filterMode: mode }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  selectJob: (jobId) => set({ selectedJobId: jobId }),

  openCreateEditor: () => set({ isEditorOpen: true, editingJobId: null, copyingJobId: null }),
  openEditEditor: (jobId) => set({ isEditorOpen: true, editingJobId: jobId, copyingJobId: null }),
  openCopyEditor: (jobId) => set({ isEditorOpen: true, editingJobId: null, copyingJobId: jobId }),
  closeEditor: () => set({ isEditorOpen: false, editingJobId: null, copyingJobId: null }),

  loadJobs: async () => {
    const { filterMode, selectedJobId } = get();
    set({ isLoading: true, error: null });

    try {
      const jobs = await cronClient.listJobs(
        filterMode === 'all' ? undefined : { enabled: filterMode === 'enabled' }
      );

      const latestPairs = await Promise.all(
        jobs.map(async (job) => [job.id, await loadLatestExecution(job.id)] as const)
      );
      const latestExecutions = Object.fromEntries(latestPairs);

      const nextSelectedJobId =
        selectedJobId && jobs.some((job) => job.id === selectedJobId)
          ? selectedJobId
          : jobs[0]?.id || null;

      set({
        jobs,
        latestExecutions,
        selectedJobId: nextSelectedJobId,
      });
    } catch (error) {
      logger.error('Failed to load cron jobs', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load cron jobs',
      });
    } finally {
      set({ isLoading: false });
    }
  },

  loadStats: async () => {
    try {
      const stats = await cronClient.getStats();
      set({ stats });
    } catch (error) {
      logger.error('Failed to load cron stats', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load cron stats',
      });
    }
  },

  loadExecutions: async (jobId, limit = 20) => {
    try {
      const executions = await cronClient.getExecutions(jobId, limit);
      // host 契约返回旧→新（cronPersistence LIMIT+reverse），store 统一归一成新→旧（FB-591）。
      const sorted = [...executions].sort(
        (a, b) => b.scheduledAt - a.scheduledAt || (b.startedAt ?? 0) - (a.startedAt ?? 0)
      );
      set((state) => ({
        executionsByJobId: {
          ...state.executionsByJobId,
          [jobId]: sorted,
        },
        latestExecutions: {
          ...state.latestExecutions,
          [jobId]: sorted[0] ?? null,
        },
      }));
    } catch (error) {
      logger.error('Failed to load cron executions', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load cron executions',
      });
    }
  },

  loadRecentExecutions: async (limit = 50) => {
    try {
      const recentExecutions = await cronClient.getRecentExecutions(limit);
      set({ recentExecutions });
    } catch (error) {
      logger.error('Failed to load recent cron executions', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load recent cron executions',
      });
    }
  },

  syncRunningExecutions: async () => {
    try {
      const recent = await cronClient.getRecentExecutions(50);
      const byId = new Map(recent.map((execution) => [execution.id, execution]));
      let changed = false;
      set((state) => {
        const latestExecutions = { ...state.latestExecutions };
        let latestChanged = false;
        for (const [jobId, known] of Object.entries(latestExecutions)) {
          const fresh = known ? byId.get(known.id) : undefined;
          if (fresh && fresh.status !== known?.status) {
            latestExecutions[jobId] = fresh;
            latestChanged = true;
          }
        }
        const recentChanged = JSON.stringify(recent) !== JSON.stringify(state.recentExecutions);
        changed = recentChanged || latestChanged;
        if (!changed) return state;
        return {
          ...(recentChanged ? { recentExecutions: recent } : {}),
          ...(latestChanged ? { latestExecutions } : {}),
        };
      });
      if (changed) await get().loadStats();
    } catch (error) {
      logger.warn('Failed to sync running cron executions', { error });
    }
  },

  refresh: async () => {
    await Promise.all([get().loadJobs(), get().loadStats()]);
    const { selectedJobId } = get();
    if (selectedJobId) {
      await get().loadExecutions(selectedJobId);
    }
  },

  createJob: async (input) => {
    const created = await cronClient.createJob(input);
    await get().refresh();
    set({
      selectedJobId: created.id,
      // 角色绑定任务保存后编辑器保持打开：组件切到「已保存」复述视图，Done 才关
      // （N-ROLE-ROUTINE-RESTATE）。这里若照旧落 isEditorOpen:false，Modal 会连带
      // 复述视图一起卸载，视图永远出不来。webhook 任务同理：一次性链接卡（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）。
      ...(isRoleBoundCronJob(created) || isWebhookCronJob(created)
        ? {}
        : { isEditorOpen: false, editingJobId: null, copyingJobId: null }),
    });
    return created;
  },

  updateJob: async (jobId, updates) => {
    const updated = await cronClient.updateJob(jobId, updates);
    await get().refresh();
    set({
      ...(updated && isRoleBoundCronJob(updated)
        ? {}
        : { isEditorOpen: false, editingJobId: null, copyingJobId: null }),
    });
    return updated;
  },

  deleteJob: async (jobId) => {
    const ok = await cronClient.deleteJob(jobId);
    if (ok) {
      set((state) => {
        const nextExecutions = { ...state.executionsByJobId };
        const nextLatest = { ...state.latestExecutions };
        delete nextExecutions[jobId];
        delete nextLatest[jobId];
        return {
          executionsByJobId: nextExecutions,
          latestExecutions: nextLatest,
          selectedJobId: state.selectedJobId === jobId ? null : state.selectedJobId,
        };
      });
      await get().refresh();
    }
    return ok;
  },

  triggerJob: async (jobId) => {
    const execution = await cronClient.triggerJob(jobId);
    await Promise.all([get().loadExecutions(jobId), get().loadStats()]);
    return execution;
  },

  setEventActionMode: async (jobId, mode) => {
    const updated = await cronClient.setEventActionMode(jobId, mode);
    if (updated) {
      set((state) => ({ jobs: state.jobs.map((job) => (job.id === jobId ? updated : job)) }));
    }
    return updated;
  },
}));
