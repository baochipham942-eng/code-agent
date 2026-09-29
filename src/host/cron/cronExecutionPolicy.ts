import { Cron } from 'croner';
import { CRON_GUARDRAILS } from '../../shared/constants';
import type { CronJobDefinition, CronMissedReason } from '../../shared/contract/cron';
import { suggestCronStaggerMinute } from '../../shared/cronStagger';
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

/**
 * every 调度 → cron 表达式。小时/天级任务的分钟位用 jobId 哈希的稳定错峰值，
 * 不再全部落在 :00（整点扎堆源头）；同一任务重启后分钟不变（jobId 持久）。
 * （自 cronService 平移，逐字未动——该文件贴 max-lines 线。）
 */
export function intervalToCron(interval: number, unit: string, jobId: string): string {
  switch (unit) {
    case 'seconds':
      return `*/${interval} * * * * *`;
    case 'minutes':
      return `0 */${interval} * * * *`;
    case 'hours':
      return `0 ${suggestCronStaggerMinute(jobId)} */${interval} * * *`;
    case 'days':
      return `0 ${suggestCronStaggerMinute(jobId)} 0 */${interval} * *`;
    case 'weeks':
      throw new Error('Unsupported interval unit "weeks"; cron day-of-week syntax cannot express every N weeks.');
    default:
      return `0 */${interval} * * * *`; // Default to minutes
  }
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

/** 启动扫描对一次性（at）任务的处置决定（纯函数，副作用留在 cronService）。 */
export type OneTimeJobStartupDecision =
  | { kind: 'register' }
  | { kind: 'catch-up'; dueAt: number }
  | {
    kind: 'disable';
    /** 解析得出到期时间；datetime 解析不出来时 undefined（此时只停用、不记 missed）。 */
    dueAt?: number;
    missedReason: CronMissedReason;
    /** true = 该趟已开始过、跑一半进程崩溃（不整趟重跑）；false = 离线错过根本没跑。 */
    alreadyStarted: boolean;
  };

/**
 * 过期的一次性任务在启动加载时怎么处置（maka 护栏自查 A5-⑥ + N-CRON-RESILIENCE R3）：
 * - 还没到期 → 照常注册；
 * - 刚错过（≤MISFIRE_GRACE_MS）且没跑过 → 宽限窗内补跑这一趟；
 * - 刚错过但**已开始过**（T 点开跑、跑一半崩溃，重启时执行记录已被标 interrupted）→
 *   停用不重跑（不变量 B：整趟重跑 = 重复副作用 + 第二笔模型费用）；
 * - 超窗 → 离线错过停用。
 * lastRunAt 判据与循环任务宽限窗补跑同构：`(lastRunAt ?? createdAt) < dueAt` 才补跑。
 */
export function decideOneTimeJobStartup(
  job: Pick<CronJobDefinition, 'schedule' | 'createdAt'>,
  now: number,
  lastRunAt: number | undefined,
): OneTimeJobStartupDecision {
  if (job.schedule.type !== 'at') return { kind: 'register' };
  const ts = typeof job.schedule.datetime === 'number'
    ? job.schedule.datetime
    : Date.parse(String(job.schedule.datetime));
  if (Number.isFinite(ts) && ts > now) return { kind: 'register' };
  if (Number.isFinite(ts) && now - ts <= CRON_GUARDRAILS.MISFIRE_GRACE_MS) {
    const startedAt = lastRunAt ?? job.createdAt;
    return startedAt < ts
      ? { kind: 'catch-up', dueAt: ts }
      : { kind: 'disable', dueAt: ts, missedReason: 'interrupted', alreadyStarted: true };
  }
  return { kind: 'disable', dueAt: Number.isFinite(ts) ? ts : undefined, missedReason: 'app-offline', alreadyStarted: false };
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
