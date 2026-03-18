import { create } from 'zustand';
import type {
  CronJobDefinition,
  CronJobExecution,
  CronServiceStats,
} from '@shared/types';
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
  selectedJobId: string | null;
  filterMode: CronJobFilterMode;
  searchQuery: string;
  isLoading: boolean;
  isEditorOpen: boolean;
  editingJobId: string | null;
  error: string | null;

  setFilterMode: (mode: CronJobFilterMode) => void;
  setSearchQuery: (query: string) => void;
  selectJob: (jobId: string | null) => void;
  openCreateEditor: () => void;
  openEditEditor: (jobId: string) => void;
  closeEditor: () => void;
  loadJobs: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadExecutions: (jobId: string, limit?: number) => Promise<void>;
  refresh: () => Promise<void>;
  createJob: (input: CreateCronJobInput) => Promise<CronJobDefinition>;
  updateJob: (jobId: string, updates: UpdateCronJobInput) => Promise<CronJobDefinition | null>;
  deleteJob: (jobId: string) => Promise<boolean>;
  triggerJob: (jobId: string) => Promise<CronJobExecution | null>;
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
  selectedJobId: null,
  filterMode: 'all',
  searchQuery: '',
  isLoading: false,
  isEditorOpen: false,
  editingJobId: null,
  error: null,

  setFilterMode: (mode) => set({ filterMode: mode }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  selectJob: (jobId) => set({ selectedJobId: jobId }),

  openCreateEditor: () => set({ isEditorOpen: true, editingJobId: null }),
  openEditEditor: (jobId) => set({ isEditorOpen: true, editingJobId: jobId }),
  closeEditor: () => set({ isEditorOpen: false, editingJobId: null }),

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
      set((state) => ({
        executionsByJobId: {
          ...state.executionsByJobId,
          [jobId]: executions,
        },
        latestExecutions: {
          ...state.latestExecutions,
          [jobId]: executions[0] || executions[executions.length - 1] || null,
        },
      }));
    } catch (error) {
      logger.error('Failed to load cron executions', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load cron executions',
      });
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
      isEditorOpen: false,
      editingJobId: null,
    });
    return created;
  },

  updateJob: async (jobId, updates) => {
    const updated = await cronClient.updateJob(jobId, updates);
    await get().refresh();
    set({
      isEditorOpen: false,
      editingJobId: null,
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
}));
