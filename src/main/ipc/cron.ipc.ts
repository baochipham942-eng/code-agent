// ============================================================================
// Cron IPC Handlers
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getCronService } from '../cron/cronService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CronIPC');

export function registerCronHandlers(): void {
  ipcMain.handle(IPC_DOMAINS.CRON, async (_event, request: IPCRequest) => {
    const { action, payload } = request;
    const cronService = getCronService();

    try {
      switch (action) {
        case 'listJobs': {
          const { filter } = (payload || {}) as { filter?: { enabled?: boolean; tags?: string[] } };
          const jobs = cronService.listJobs(filter);
          return { success: true, data: jobs } satisfies IPCResponse;
        }

        case 'createJob': {
          const job = await cronService.createJob(payload as any);
          return { success: true, data: job } satisfies IPCResponse;
        }

        case 'updateJob': {
          const { jobId, updates } = payload as { jobId: string; updates: any };
          const job = await cronService.updateJob(jobId, updates);
          return { success: true, data: job } satisfies IPCResponse;
        }

        case 'deleteJob': {
          const { jobId } = payload as { jobId: string };
          const result = await cronService.deleteJob(jobId);
          return { success: true, data: result } satisfies IPCResponse;
        }

        case 'triggerJob': {
          const { jobId } = payload as { jobId: string };
          const execution = await cronService.triggerJob(jobId);
          return { success: true, data: execution } satisfies IPCResponse;
        }

        case 'getExecutions': {
          const { jobId, limit } = payload as { jobId: string; limit?: number };
          const executions = cronService.getJobExecutions(jobId, limit);
          return { success: true, data: executions } satisfies IPCResponse;
        }

        case 'getStats': {
          const stats = cronService.getStats();
          return { success: true, data: stats } satisfies IPCResponse;
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown cron action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Cron IPC error:', error);
      return {
        success: false,
        error: { code: 'CRON_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      } satisfies IPCResponse;
    }
  });
}
