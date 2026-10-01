import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import { minimumIntervalSecondsForLocation } from './cronExecutionPolicy';
import {
  normalizeCronExecutionRow,
  parseCronExecutionTrigger,
  parseJsonValue,
  type CronExecutionRow,
} from './cronNormalizers';

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
      (id, name, description, schedule_type, schedule, action, runs_on, max_run_budget, min_interval_seconds, result_channel, cloud_job_id, enabled, max_retries, retry_delay, timeout, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        schedule_type = excluded.schedule_type,
        schedule = excluded.schedule,
        action = excluded.action,
        runs_on = excluded.runs_on,
        max_run_budget = excluded.max_run_budget,
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
      minimumIntervalSecondsForLocation(job.runsOn),
      job.resultChannel ?? null, cloudJobId ?? null,
      job.enabled ? 1 : 0, job.maxRetries || 0, job.retryDelay ?? null,
      job.timeout || 60000, job.tags ? JSON.stringify(job.tags) : null,
      job.metadata ? JSON.stringify(job.metadata) : '{}',
      job.createdAt, job.updatedAt,
    );
  } catch (error) {
    console.error('[CronService] Failed to save job to database:', error);
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
      (id, job_id, session_id, status, scheduled_at, started_at, completed_at, duration, result, error, retry_attempt, exit_code, trigger_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      execution.id, execution.jobId, execution.sessionId || null, execution.status,
      execution.scheduledAt, execution.startedAt || null,
      execution.completedAt || null, execution.duration || null,
      execution.result ? JSON.stringify(execution.result) : null,
      execution.error || null, execution.retryAttempt,
      execution.exitCode || null,
      execution.trigger ? JSON.stringify(execution.trigger) : null,
    );
  } catch (error) {
    console.error('[CronService] Failed to save execution to database:', error);
  }
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
