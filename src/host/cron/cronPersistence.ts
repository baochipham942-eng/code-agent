import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import { resolveCronEventActionMode } from '../../shared/cronEventActionMode';
import { minimumIntervalSecondsForLocation } from './cronExecutionPolicy';
import {
  normalizeCronExecutionRow,
  parseCronExecutionTrigger,
  parseJsonValue,
  type CronExecutionRow,
} from './cronNormalizers';

/** 增量成本写的默认节流窗（毫秒）：突发模型调用至多每秒一写 + 一次尾随补写。 */
const CRON_COST_WRITE_THROTTLE_MS = 1_000;

export function upsertCronExecutionInMemory(
  executions: Map<string, CronJobExecution[]>,
  execution: CronJobExecution,
): void {
  const history = executions.get(execution.jobId) ?? [];
  const existingIndex = history.findIndex((item) => item.id === execution.id);
  if (existingIndex >= 0) history[existingIndex] = execution;
  else history.push(execution);
  executions.set(execution.jobId, history.slice(-100));
}

/**
 * 短缓存（任务列表 limit=1）盖不住请求的窗口时，与库里的页合并。
 * 同 id 保留内存对象：刚跑完、尚未落库，或 executeJob 还在原地改的那一条不能被库里的旧行换掉。
 * 不把合并结果写回内存历史——连败计数只看本进程推进过的尾部，一次历史读取不能把旧失败灌进去。
 */
export function mergeCronExecutionWindow(
  cached: readonly CronJobExecution[],
  persisted: readonly CronJobExecution[],
  limit: number,
): CronJobExecution[] {
  const byId = new Map<string, CronJobExecution>();
  for (const row of persisted) byId.set(row.id, row);
  for (const row of cached) byId.set(row.id, row);
  const merged = [...byId.values()].sort((a, b) => {
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
    return (a.startedAt ?? 0) - (b.startedAt ?? 0);
  });
  return merged.slice(-limit);
}

function mapCronExecutionRows(rows: unknown[]): CronJobExecution[] {
  return rows.map(normalizeCronExecutionRow).filter((row): row is CronExecutionRow => row !== null).map((row) => ({
    id: row.id,
    jobId: row.job_id,
    runsOn: row.runs_on,
    sessionId: row.session_id || undefined,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    duration: row.duration ?? undefined,
    result: parseJsonValue(row.result),
    error: row.error || undefined,
    retryAttempt: row.retry_attempt,
    exitCode: row.exit_code ?? undefined,
    trigger: parseCronExecutionTrigger(row.trigger_json),
    cost: row.cost_usd ?? undefined,
  }));
}

export async function saveCronJob(
  job: CronJobDefinition,
  cloudJobId?: string,
): Promise<void> {
  try {
    const db = getDatabase().getDb();
    if (!db) return;
    db.prepare(`
      INSERT INTO cron_jobs
      (id, name, description, schedule_type, schedule, action, runs_on, max_run_budget, max_runs, run_count, min_interval_seconds, result_channel, cloud_job_id, enabled, max_retries, retry_delay, timeout, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        schedule_type = excluded.schedule_type,
        schedule = excluded.schedule,
        action = excluded.action,
        runs_on = excluded.runs_on,
        max_run_budget = excluded.max_run_budget,
        max_runs = excluded.max_runs,
        run_count = excluded.run_count,
        min_interval_seconds = excluded.min_interval_seconds,
        result_channel = excluded.result_channel,
        cloud_job_id = excluded.cloud_job_id,
        enabled = excluded.enabled,
        max_retries = excluded.max_retries,
        retry_delay = excluded.retry_delay,
        timeout = excluded.timeout,
        tags = excluded.tags,
        metadata = excluded.metadata,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      job.id, job.name, job.description || null,
      job.scheduleType, JSON.stringify(job.schedule), JSON.stringify(job.action),
      job.runsOn, job.maxRunBudget ?? null,
      job.maxRuns ?? null, job.runCount ?? 0,
      minimumIntervalSecondsForLocation(job.runsOn),
      job.resultChannel ?? null, cloudJobId ?? null,
      job.enabled ? 1 : 0, job.maxRetries || 0, job.retryDelay ?? null,
      job.timeout || 60000, job.tags ? JSON.stringify(job.tags) : null,
      job.metadata ? JSON.stringify(job.metadata) : '{}',
      job.createdAt, job.updatedAt,
    );
  } catch (error) {
    console.error('[CronService] Failed to save job to database:', error);
    return;
  }
  saveCronJobActionMode(job);
}

/**
 * 事件任务执行档单列窄写（N-TRIGGER-OBSERVE-MODE）：只有显式 auto 落 auto，其余 event 任务
 * 落 observe。单独一条语句而不并进上面的整行 upsert：action_mode 列
 * 万一没迁移成功，任务本身照常保存，读回时 NULL 按 observe 处理（fail-closed，只收窄）。
 */
function saveCronJobActionMode(job: CronJobDefinition): void {
  // 非 event 任务不写：读侧只对 event 任务解释该列；改回 event 时 carryEventActionMode 必给出值并写入。
  const mode = resolveCronEventActionMode(job);
  if (mode === null) return;
  try {
    const db = getDatabase().getDb();
    if (!db) return;
    db.prepare('UPDATE cron_jobs SET action_mode = ? WHERE id = ?').run(mode, job.id);
  } catch (error) {
    console.error('[CronService] Failed to save job action mode (event job reads back as observe):', error);
  }
}

/**
 * 只更新运行计数列（N-CRON-BUDGET-EXPOSE R1，PR#2208 ai-review Important）：
 * 次数结算每趟都要记数，走 saveCronJob 整行 upsert 会顺改 updated_at 造成无意义
 * churn；单列 UPDATE 不碰其它字段。与 saveCronJob 同款：落库失败只记日志，
 * 由内存计数继续撑着，不许把异常甩回 executeJob 的 finally。
 */
export async function updateCronJobRunCount(jobId: string, runCount: number): Promise<void> {
  try {
    const db = getDatabase().getDb();
    if (!db) return;
    db.prepare('UPDATE cron_jobs SET run_count = ? WHERE id = ?').run(runCount, jobId);
  } catch (error) {
    console.error('[CronService] Failed to update job run count:', error);
  }
}

export async function deleteCronJob(jobId: string): Promise<void> {
  try {
    const db = getDatabase().getDb();
    if (!db) return;
    db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(jobId);
  } catch (error) {
    console.error('[CronService] Failed to delete job from database:', error);
  }
}

export async function saveCronExecution(execution: CronJobExecution): Promise<void> {
  try {
    const db = getDatabase().getDb();
    if (!db) return;
    db.prepare(`
      INSERT OR REPLACE INTO cron_executions
      (id, job_id, session_id, status, scheduled_at, started_at, completed_at, duration, result, error, retry_attempt, exit_code, trigger_json, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      execution.id, execution.jobId, execution.sessionId || null, execution.status,
      execution.scheduledAt, execution.startedAt || null,
      execution.completedAt || null, execution.duration || null,
      execution.result ? JSON.stringify(execution.result) : null,
      execution.error || null, execution.retryAttempt,
      execution.exitCode || null,
      execution.trigger ? JSON.stringify(execution.trigger) : null,
      execution.cost ?? null,
    );
  } catch (error) {
    console.error('[CronService] Failed to save execution to database:', error);
  }
}

/**
 * 运行中执行的增量成本窄写（N-CRON-RUN-LEDGER-VISIBLE-FU1）：计量器每记一笔真实
 * usage 就把增量累进仍处于 running 的执行行 cost_usd。此前成本只在 run 结束时写，
 * 进程被杀/挂死后 markInterruptedCronExecutions 只翻状态，账本是 dash——现在
 * 已发生的成本中途就落了库。约束：
 * - 只碰 cost_usd 一列，且 WHERE 限定 status='running'：收尾的整行写入（完成/失败/
 *   interrupted）天然赢过这里，迟到的尾随写也不会覆盖终态。
 * - 增量累加（COALESCE + delta）而非整额覆盖：同一条执行记录的重试链每趟一个计量器，
 *   各写各的增量，中途被杀不冲销前几趟已花的钱。
 * - 节流：至多每 throttleMs 一写 + 一次尾随补写，模型调用突发不会连打 SQLite；
 *   now 可注入（测试用），默认 Date.now（本文件在 src/host/cron，不受 repositories
 *   禁直接 Date.now 的约束）。
 */
export function createCronExecutionCostWriter(
  executionId: string,
  options?: { now?: () => number; throttleMs?: number },
): (costUsd: number) => void {
  const now = options?.now ?? Date.now;
  const throttleMs = options?.throttleMs ?? CRON_COST_WRITE_THROTTLE_MS;
  let meterTotalUsd = 0;
  let unflushedUsd = 0;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    trailingTimer = null;
    lastFlushAt = now();
    const deltaUsd = unflushedUsd;
    unflushedUsd = 0;
    if (deltaUsd <= 0) return;
    try {
      const db = getDatabase().getDb();
      if (!db) return;
      db.prepare(`
        UPDATE cron_executions
        SET cost_usd = COALESCE(cost_usd, 0) + ?
        WHERE id = ? AND status = 'running'
      `).run(deltaUsd, executionId);
    } catch (error) {
      // 落库失败把增量还回去，等下一笔/尾随写补上；写库本身 best-effort，不外抛。
      unflushedUsd = deltaUsd + unflushedUsd;
      console.error('[CronService] Failed to persist incremental run cost:', error);
    }
  };

  return (costUsd: number): void => {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const deltaUsd = Math.round((costUsd - meterTotalUsd) * 1e6) / 1e6;
    meterTotalUsd = costUsd;
    if (deltaUsd <= 0) return;
    unflushedUsd = Math.round((unflushedUsd + deltaUsd) * 1e6) / 1e6;
    const sinceLastFlush = now() - lastFlushAt;
    if (sinceLastFlush >= throttleMs) {
      if (trailingTimer !== null) clearTimeout(trailingTimer);
      flush();
      return;
    }
    if (trailingTimer !== null) return;
    trailingTimer = setTimeout(flush, Math.max(throttleMs - sinceLastFlush, 0));
    // 尾随写不拖住进程退出（Node Timeout 才有 unref；别处运行时兜底）。
    (trailingTimer as { unref?: () => void }).unref?.();
  };
}

/** 单任务执行历史（倒序取 limit 后翻回时间正序）。 */
export function loadCronExecutionsByJob(jobId: string, limit: number): CronJobExecution[] {
  try {
    const db = getDatabase().getDb();
    if (!db) return [];
    const rows = db.prepare(`
      SELECT cron_executions.*, cron_jobs.runs_on AS runs_on
      FROM cron_executions
      JOIN cron_jobs ON cron_jobs.id = cron_executions.job_id
      WHERE cron_executions.job_id = ?
      ORDER BY cron_executions.scheduled_at DESC
      LIMIT ?
    `).all(jobId, limit) as unknown[];
    return mapCronExecutionRows(rows.reverse());
  } catch (error) {
    console.error('[CronService] Failed to load executions from database:', error);
    return [];
  }
}

/** 跨任务执行流（自动化页「运行记录」tab）：全部任务的执行按时间倒序。DB 是权威源。 */
export function loadRecentCronExecutions(limit: number): CronJobExecution[] {
  try {
    const db = getDatabase().getDb();
    if (!db) return [];
    const rows = db.prepare(`
      SELECT cron_executions.*, cron_jobs.runs_on AS runs_on
      FROM cron_executions
      JOIN cron_jobs ON cron_jobs.id = cron_executions.job_id
      ORDER BY cron_executions.scheduled_at DESC
      LIMIT ?
    `).all(limit) as unknown[];
    return mapCronExecutionRows(rows);
  } catch (error) {
    console.error('[CronService] Failed to load recent executions from database:', error);
    return [];
  }
}

export function loadCronExecutionStatus(
  executionId: string,
): CronJobExecution['status'] | undefined {
  try {
    const db = getDatabase().getDb();
    if (!db) return undefined;
    const row = db.prepare('SELECT status FROM cron_executions WHERE id = ?').get(executionId) as
      | { status?: CronJobExecution['status'] }
      | undefined;
    return row?.status;
  } catch {
    return undefined;
  }
}

/**
 * 启动时把残留的 running 执行记录标记为 interrupted（maka 护栏自查 A5-④）：
 * 上次进程退出前没跑完的执行会永远停在 running，误导用户以为还在跑。
 * 单条 UPDATE，幂等（重复跑不会二次改动已是 interrupted 的行），不影响启动耗时。
 */
export function markInterruptedCronExecutions(): Promise<void> {
  try {
    const db = getDatabase().getDb();
    if (!db) return Promise.resolve();
    const result = db.prepare(`
        UPDATE cron_executions
        SET status = 'interrupted', completed_at = COALESCE(completed_at, ?)
        WHERE status = 'running'
      `).run(Date.now());
    if (result.changes > 0) {
      console.error(`[CronService] Marked ${result.changes} stale running execution(s) as interrupted`);
    }
  } catch (error) {
    console.error('[CronService] Failed to mark interrupted executions:', error);
  }
  return Promise.resolve();
}

/** 任务最近一次执行开始时间（ms）；没有执行记录时 undefined。 */
export function loadCronLastRunAt(jobId: string): number | undefined {
  try {
    const db = getDatabase().getDb();
    if (!db) return undefined;
    const row = db.prepare(`
        SELECT MAX(started_at) AS last_run_at
        FROM cron_executions
        WHERE job_id = ? AND started_at IS NOT NULL
      `).get(jobId) as { last_run_at?: number | null } | undefined;
    return typeof row?.last_run_at === 'number' ? row.last_run_at : undefined;
  } catch (error) {
    console.error('[CronService] Failed to load cron last-run timestamp:', error);
    return undefined;
  }
}
