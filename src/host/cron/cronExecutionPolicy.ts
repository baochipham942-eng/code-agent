import { Cron } from 'croner';
import { CRON_GUARDRAILS } from '../../shared/constants';
import type { CronJobDefinition, CronScheduleType } from '../../shared/contract/cron';
import {
  createScopedCostLimit,
  isScopedCostLimitExceeded,
} from '../services/core/scopedCostLimit';

const LOCAL_MIN_INTERVAL_SEC = 60;
const CLOUD_MIN_INTERVAL_SEC = 60 * 60;

/** Convert contract startAt/endAt values for Croner's native window options. */
export function scheduleBoundToDate(value: string | number): Date {
  return new Date(typeof value === 'number' ? value : Date.parse(value));
}

export function computeCronFireJitterMs(
  scheduleType: CronScheduleType,
  rand: () => number = Math.random,
): number {
  if (scheduleType === 'at') return 0;
  return Math.floor(rand() * CRON_GUARDRAILS.FIRE_JITTER_MAX_MS);
}

function everyScheduleIntervalSeconds(schedule: CronJobDefinition['schedule']): number | undefined {
  if (schedule.type !== 'every') return undefined;
  const multiplier = {
    seconds: 1,
    minutes: 60,
    hours: 60 * 60,
    days: 24 * 60 * 60,
  }[schedule.unit];
  return schedule.interval * multiplier;
}

function cronScheduleMinimumIntervalSeconds(schedule: CronJobDefinition['schedule']): number | undefined {
  if (schedule.type !== 'cron') return undefined;
  const probe = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    const runs = probe.nextRuns(16);
    let minimum: number | undefined;
    for (let index = 1; index < runs.length; index++) {
      const gap = (runs[index].getTime() - runs[index - 1].getTime()) / 1000;
      minimum = minimum === undefined ? gap : Math.min(minimum, gap);
    }
    return minimum;
  } finally {
    probe.stop();
  }
}

export function minimumIntervalSecondsForLocation(runsOn: CronJobDefinition['runsOn']): number {
  return runsOn === 'cloud' ? CLOUD_MIN_INTERVAL_SEC : LOCAL_MIN_INTERVAL_SEC;
}

export function assertExecutionLocationConstraints(
  definition: Pick<CronJobDefinition, 'runsOn' | 'schedule' | 'maxRunBudget'>,
): void {
  if (
    definition.maxRunBudget != null
    && (!Number.isFinite(definition.maxRunBudget) || definition.maxRunBudget < 0)
  ) {
    throw new Error('maxRunBudget must be a finite non-negative number.');
  }
  const intervalSeconds = everyScheduleIntervalSeconds(definition.schedule)
    ?? cronScheduleMinimumIntervalSeconds(definition.schedule);
  const minimumSeconds = minimumIntervalSecondsForLocation(definition.runsOn);
  if (intervalSeconds != null && intervalSeconds < minimumSeconds) {
    const locationLabel = definition.runsOn === 'cloud' ? 'Cloud' : 'Local';
    throw new Error(`${locationLabel} jobs must have an interval of at least ${minimumSeconds} seconds.`);
  }
}

export async function runWithCronJobBudget<T>(
  maxRunBudget: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  // The unattended pool remains the shared outer budget gate. A positive
  // per-job limit adds an independent hard ceiling around this single run.
  // Both observe the same real provider usage; neither disables the other.
  if (maxRunBudget == null || maxRunBudget <= 0) return operation();

  const jobCostLimit = createScopedCostLimit(maxRunBudget);
  try {
    return await jobCostLimit.run(operation);
  } catch (error) {
    if (isScopedCostLimitExceeded(error)) {
      throw new Error(`Cron job run exceeded its $${maxRunBudget.toFixed(2)} budget limit.`, { cause: error });
    }
    throw error;
  }
}
