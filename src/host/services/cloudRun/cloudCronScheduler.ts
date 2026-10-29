// ============================================================================
// CloudCronScheduler — 云端 cron 排程（ADR-087 S4 方案 B）
// ============================================================================
// cloud webServer 自己排程：tick 到点先 admit(trigger:'cron')，只有 !duplicate
// 且 state==='running' 才把行交给注入的执行体。幂等键复用账本自己的去重：
// sessionId = cloud-cron:<jobId>、clientMessageId = cron:<jobId>:<slotMs>。
// next_run_at 在 admit 之后才推进 —— 两者之间崩溃，重启后同一槽重新 admit
// 命中 duplicate，不产生第二条 run；missed slots 合并成一次 run（取舍：不追跑
// 历史槽），at 到点触发一次后即停用。
// 执行体缺省 fail-closed：行立即 settle failed + 留痕（S4 在 OpenClaw 核对单
// 关账前不放开，cron 行绝不按 AgentRunBody 解析执行）。
// event 调度（channel / connector mail / webhook 源）一概拒绝上云：触发源在
// 本机，上云就永远等不到事件；一行不落。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { Cron } from 'croner';
import { intervalToCron, scheduleBoundToDate } from '../../cron/cronExecutionPolicy';
import type { CronScheduleConfig } from '../../../shared/contract/cron';
import { CLOUD_CRON_TICK_INTERVAL_MS } from '../../../shared/constants';
import { isTerminalCloudRunState } from '../../../shared/contract/cloudRun';
import {
  CloudCronScheduleRepository,
  type CloudCronScheduleRecord,
} from '../core/repositories/CloudCronScheduleRepository';
import type { CloudRunRecord } from '../core/repositories/CloudRunRepository';
import { createLogger } from '../infra/logger';
import type { CloudRunLedger } from './cloudRunLedger';

const logger = createLogger('CloudCronScheduler');

const CLOUD_CRON_EVENT_SCHEDULE_UNSUPPORTED = 'CLOUD_CRON_EVENT_SCHEDULE_UNSUPPORTED';

const EVENT_SCHEDULE_UNSUPPORTED_MESSAGE =
  'Event-triggered schedules (channel, mail connector, or webhook sources) cannot run in the cloud; keep this job on this computer.';

type CloudCronAccountResolver = () => string | null;

/** 与 WebRouteLogger 同形的可注入日志面；缺省 createLogger('CloudCronScheduler')。 */
interface CloudCronLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface RegisterCloudCronScheduleInput {
  accountId: string;
  jobId: string;
  schedule: CronScheduleConfig;
  requestJson: string;
  enabled?: boolean;
}

interface CloudCronSchedulerDeps {
  db: BetterSqlite3.Database;
  /** admit 走这本账（生产 = 与路由同一实例）；账户缺省也从这里解析。 */
  getLedger: () => CloudRunLedger;
  /** 与账本同一事实源的账户解析；缺省 = getLedger().resolveAccountId()。 */
  accountResolver?: CloudCronAccountResolver;
  /** 仓库层禁裸取当前时间（repositories grep 门），真钟缺省只落在这里。 */
  clock?: () => number;
  /** cron 行执行体；缺省 fail-closed（settle failed + 留痕，绝不执行）。 */
  executeRun?: (record: CloudRunRecord) => Promise<void>;
  logger?: CloudCronLogger;
}

interface CloudCronTickResult {
  admitted: number;
  executed: number;
  skippedAccounts: number;
  failed: number;
}

/**
 * after 之后第一次出现（严格晚于 after）；没有未来出现返回 null。
 * at 的出现时刻就是 datetime 本身；every/cron 用 croner，与本地 CronService
 * 同一换算源（intervalToCron 的稳定错峰、startAt/endAt 窗口、timezone）。
 */
function nextOccurrence(schedule: CronScheduleConfig, jobId: string, afterMs: number): number | null {
  switch (schedule.type) {
    case 'at': {
      const at = scheduleBoundToDate(schedule.datetime).getTime();
      return Number.isFinite(at) && at > afterMs ? at : null;
    }
    case 'every':
    case 'cron': {
      const expression = schedule.type === 'cron'
        ? schedule.expression
        : intervalToCron(schedule.interval, schedule.unit, jobId);
      let cron: Cron | undefined;
      try {
        cron = new Cron(expression, {
          paused: true,
          ...(schedule.type === 'cron' && schedule.timezone ? { timezone: schedule.timezone } : {}),
          ...(schedule.type === 'every' && schedule.startAt != null
            ? { startAt: scheduleBoundToDate(schedule.startAt) }
            : {}),
          ...(schedule.type === 'every' && schedule.endAt != null
            ? { stopAt: scheduleBoundToDate(schedule.endAt) }
            : {}),
        });
        const next = cron.nextRun(new Date(afterMs));
        return next instanceof Date ? next.getTime() : null;
      } finally {
        cron?.stop();
      }
    }
    default:
      return null;
  }
}

export class CloudCronScheduler {
  private readonly repository: CloudCronScheduleRepository;
  private readonly getLedger: () => CloudRunLedger;
  private readonly accountResolver: CloudCronAccountResolver;
  private readonly clock: () => number;
  private readonly executeRun: (record: CloudRunRecord) => Promise<void>;
  private readonly log: CloudCronLogger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CloudCronSchedulerDeps) {
    this.repository = new CloudCronScheduleRepository(deps.db);
    this.getLedger = deps.getLedger;
    this.accountResolver = deps.accountResolver ?? (() => deps.getLedger().resolveAccountId());
    this.clock = deps.clock ?? Date.now;
    this.executeRun = deps.executeRun ?? ((record) => this.failClosedExecute(record));
    this.log = deps.logger ?? logger;
  }

  /**
   * 启动 tick 循环：立即跑一趟（停机窗口的 missed slots 合并成一次），再按
   * interval 定时。返回停止函数；重复 start 是幂等的。
   */
  start(intervalMs: number = CLOUD_CRON_TICK_INTERVAL_MS): () => void {
    if (this.timer) return () => this.stop();
    this.runTick();
    this.timer = setInterval(() => this.runTick(), intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 到点的一趟：每个到期行 admit → 推进 next_run_at → 按规则交执行体。 */
  tick(): CloudCronTickResult {
    const result: CloudCronTickResult = { admitted: 0, executed: 0, skippedAccounts: 0, failed: 0 };
    const accountId = this.accountResolver();
    if (!accountId) return result;
    const now = this.clock();
    for (const schedule of this.repository.listDueSchedules(now)) {
      if (schedule.accountId !== accountId) {
        result.skippedAccounts += 1;
        this.log.warn('[CloudCron] Skip due schedule owned by another account', {
          jobId: schedule.jobId,
          ownerAccount: schedule.accountId,
          resolvedAccount: accountId,
        });
        continue;
      }
      try {
        this.fireDueSchedule(schedule, now, result);
      } catch (error) {
        // admit 前抛错：next_run_at 未动，下趟重试；admit 后推进前抛错：下趟
        // 重新 admit 命中 duplicate，仍只占一个槽。
        result.failed += 1;
        this.log.error('[CloudCron] Fire due schedule failed; will retry next tick', {
          accountId,
          jobId: schedule.jobId,
          error,
        });
      }
    }
    return result;
  }

  /**
   * 登记一张云端定时声明。event 调度（任何源）拒绝并返回稳定码
   * CLOUD_CRON_EVENT_SCHEDULE_UNSUPPORTED，一行不落；at/every/cron 接受，
   * next_run_at 取「now 之后第一次出现」（at 已过期则取 datetime 本身，
   * 下一趟触发一次即停用 —— missed 一次性槽不追跑，只补一次）。
   */
  registerSchedule(
    input: RegisterCloudCronScheduleInput,
  ): { ok: true; record: CloudCronScheduleRecord } | { ok: false; code: string; message: string } {
    if (!input.accountId?.trim()) throw new Error('Cloud cron schedule accountId must be non-empty');
    if (!input.jobId?.trim()) throw new Error('Cloud cron schedule jobId must be non-empty');
    if (!input.requestJson) throw new Error('Cloud cron schedule requestJson must be non-empty');
    const schedule = input.schedule;
    if (schedule?.type === 'event') {
      return {
        ok: false,
        code: CLOUD_CRON_EVENT_SCHEDULE_UNSUPPORTED,
        message: EVENT_SCHEDULE_UNSUPPORTED_MESSAGE,
      };
    }
    if (schedule?.type !== 'at' && schedule?.type !== 'every' && schedule?.type !== 'cron') {
      throw new Error(`Unsupported cloud cron schedule type: ${JSON.stringify(schedule)}`);
    }
    // 先挡非法声明再碰 croner：*/0 或非法表达式抛的是 croner 的错，不是可读的报错
    if (schedule.type === 'at' && !Number.isFinite(scheduleBoundToDate(schedule.datetime).getTime())) {
      throw new Error(`Invalid datetime for cloud cron at-schedule ${input.jobId}: ${String(schedule.datetime)}`);
    }
    if (schedule.type === 'every' && (!Number.isInteger(schedule.interval) || schedule.interval < 1)) {
      throw new Error(`Invalid interval for cloud cron every-schedule ${input.jobId}: ${String(schedule.interval)}`);
    }
    const now = this.clock();
    let nextRunAt: number | null;
    try {
      nextRunAt = schedule.type === 'at'
        ? scheduleBoundToDate(schedule.datetime).getTime()
        : nextOccurrence(schedule, input.jobId, now);
    } catch (error) {
      throw new Error(
        `Invalid schedule for cloud cron job ${input.jobId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const record = this.repository.upsertSchedule({
      accountId: input.accountId.trim(),
      jobId: input.jobId.trim(),
      scheduleJson: JSON.stringify(schedule),
      requestJson: input.requestJson,
      enabled: input.enabled ?? true,
      nextRunAt,
      now,
    });
    return { ok: true, record };
  }

  private fireDueSchedule(schedule: CloudCronScheduleRecord, now: number, result: CloudCronTickResult): void {
    const slot = schedule.nextRunAt;
    if (slot === null) return;
    const jobId = schedule.jobId;
    const admission = this.getLedger().admit({
      sessionId: `cloud-cron:${jobId}`,
      trigger: 'cron',
      requestJson: schedule.requestJson,
      clientMessageId: `cron:${jobId}:${slot}`,
    });
    const next = this.nextAfterFire(schedule, now);
    this.repository.advanceSchedule({
      accountId: schedule.accountId,
      jobId,
      nextRunAt: next,
      enabled: next === null ? false : true,
      lastSlot: slot,
      now,
    });
    if (!admission.duplicate) result.admitted += 1;
    if (!admission.duplicate && admission.record.state === 'running') {
      result.executed += 1;
      this.dispatchToExecutor(admission.record);
    }
  }

  /** admit 之后才推进：first occurrence strictly after now，missed slots 合并成一次。 */
  private nextAfterFire(schedule: CloudCronScheduleRecord, now: number): number | null {
    try {
      return nextOccurrence(JSON.parse(schedule.scheduleJson) as CronScheduleConfig, schedule.jobId, now);
    } catch (error) {
      // 声明坏到 croner 都解不开（registerSchedule 已挡过一道）：宁可停用也不
      // 无限重试同一槽 —— 停用是可观察状态，静默循环不是。
      this.log.error('[CloudCron] Cannot advance schedule; disabling it', {
        accountId: schedule.accountId,
        jobId: schedule.jobId,
        error,
      });
      return null;
    }
  }

  private dispatchToExecutor(record: CloudRunRecord): void {
    void this.executeRun(record).catch((error: unknown) => {
      this.log.error('[CloudCron] Cron executor rejected; settling cloud run failed', {
        runId: record.runId,
        error,
      });
      this.settleFailed(record.runId);
    });
  }

  /** 缺省执行体（fail-closed）：不执行，行落 failed + 留痕（S4 收口未放开）。 */
  private async failClosedExecute(record: CloudRunRecord): Promise<void> {
    this.log.error('[CloudCron] No cron executor configured; settling cloud run as failed (ADR-087 S4 fail-closed)', {
      runId: record.runId,
      sessionId: record.sessionId,
    });
    this.settleFailed(record.runId);
  }

  private settleFailed(runId: string): void {
    const ledger = this.getLedger();
    const current = ledger.getRun(runId);
    if (!current || isTerminalCloudRunState(current.state)) return;
    try {
      ledger.transition(runId, 'failed');
    } catch (error) {
      this.log.error('[CloudCron] Failed to settle cloud run as failed', { runId, error });
    }
  }

  private runTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.log.error('[CloudCron] tick failed', error);
    }
  }
}
