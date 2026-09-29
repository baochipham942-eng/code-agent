import { Cron } from 'croner';
import { CRON_GUARDRAILS } from '../../shared/constants';
import type { CronJobDefinition } from '../../shared/contract/cron';
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

/**
 * 触发 jitter 窗口按周期长度取（N-CRON-RESILIENCE）：
 * window = clamp(周期 × FIRE_JITTER_PERIOD_RATIO, FIRE_JITTER_MIN_MS, FIRE_JITTER_MAX_MS)。
 * 分钟级任务仍是秒级抖动（2s 下限沿用旧值），小时级任务得到分钟级抖动，天级封顶 15min。
 * 周期算不出来（解析不了的表达式）时退回下限，保持旧的防惊群基线。
 */
export function computeCronFireJitterMs(
  schedule: CronJobDefinition['schedule'],
  rand: () => number = Math.random,
): number {
  if (schedule.type === 'at') return 0;
  const periodSeconds = everyScheduleIntervalSeconds(schedule)
    ?? cronScheduleMinimumIntervalSeconds(schedule);
  const periodMs = periodSeconds != null ? periodSeconds * 1000 : undefined;
  const windowMs = periodMs == null
    ? CRON_GUARDRAILS.FIRE_JITTER_MIN_MS
    : Math.min(
      Math.max(periodMs * CRON_GUARDRAILS.FIRE_JITTER_PERIOD_RATIO, CRON_GUARDRAILS.FIRE_JITTER_MIN_MS),
      CRON_GUARDRAILS.FIRE_JITTER_MAX_MS,
    );
  return Math.floor(rand() * windowMs);
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
