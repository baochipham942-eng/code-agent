import type { CronJobDefinition } from '../../../shared/contract/cron';

export const DREAM_INTERVAL_DAYS = 7;
export const DREAM_CRON_JOB_TAG = 'dream-memory-consolidation';
export const DREAM_AUTO_PROMPT = '/dream --auto';

type DreamCronDefinition = Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'>;

export interface DreamCronBuildOptions {
  now?: number;
  workingDirectory?: string;
}

export interface DreamCronService {
  listJobs(filter?: { tags?: string[] }): Array<CronJobDefinition | Record<string, unknown>>;
  createJob(definition: DreamCronDefinition): Promise<CronJobDefinition | Record<string, unknown>>;
}

export function buildDreamCronJobDefinition(options: DreamCronBuildOptions = {}): DreamCronDefinition {
  const now = options.now ?? Date.now();
  return {
    name: '[Maintenance] Dream memory consolidation',
    description: 'Review recent sessions and write History-verified durable memory.',
    scheduleType: 'every',
    schedule: {
      type: 'every',
      interval: DREAM_INTERVAL_DAYS,
      unit: 'days',
      startAt: now,
    },
    action: {
      type: 'agent',
      agentType: 'dream',
      prompt: DREAM_AUTO_PROMPT,
      context: {
        dreamAuto: true,
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      },
    },
    enabled: true,
    tags: [DREAM_CRON_JOB_TAG],
    metadata: {
      source: 'mimocode-dream',
      intervalDays: DREAM_INTERVAL_DAYS,
    },
  };
}

export async function syncDreamCronJob(
  cron: DreamCronService,
  options: DreamCronBuildOptions = {},
): Promise<{ created: boolean; job: CronJobDefinition | Record<string, unknown> }> {
  const existing = cron.listJobs({ tags: [DREAM_CRON_JOB_TAG] });
  if (existing.length > 0) {
    return { created: false, job: existing[0] };
  }
  const job = await cron.createJob(buildDreamCronJobDefinition(options));
  return { created: true, job };
}
