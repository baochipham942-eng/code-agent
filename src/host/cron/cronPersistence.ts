import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import { minimumIntervalSecondsForLocation } from './cronExecutionPolicy';
import { normalizeCronExecutionRow, parseJsonValue, type CronExecutionRow } from './cronNormalizers';

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

export function mapCronExecutionRows(rows: unknown[]): CronJobExecution[] {
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
      INSERT OR REPLACE INTO cron_jobs
      (id, name, description, schedule_type, schedule, action, runs_on, max_run_budget, min_interval_seconds, result_channel, cloud_job_id, enabled, max_retries, retry_delay, timeout, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.name, job.description || null,
      job.scheduleType, JSON.stringify(job.schedule), JSON.stringify(job.action),
      job.runsOn, job.maxRunBudget ?? null,
      minimumIntervalSecondsForLocation(job.runsOn),
      job.resultChannel ?? null, cloudJobId ?? null,
      job.enabled ? 1 : 0, job.maxRetries || 0, job.retryDelay || 5000,
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
      (id, job_id, session_id, status, scheduled_at, started_at, completed_at, duration, result, error, retry_attempt, exit_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      execution.id, execution.jobId, execution.sessionId || null, execution.status,
      execution.scheduledAt, execution.startedAt || null,
      execution.completedAt || null, execution.duration || null,
      execution.result ? JSON.stringify(execution.result) : null,
      execution.error || null, execution.retryAttempt,
      execution.exitCode || null,
    );
  } catch (error) {
    console.error('[CronService] Failed to save execution to database:', error);
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
