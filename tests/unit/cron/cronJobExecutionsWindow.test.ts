import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

import { CronService } from '../../../src/host/cron/cronService';
import { saveCronExecution, saveCronJob } from '../../../src/host/cron/cronPersistence';

const NOW = Date.UTC(2026, 9, 26, 8, 0, 0);
const DAY = 86_400_000;

function localJob(): Parameters<typeof saveCronJob>[0] {
  return {
    id: 'job-w1',
    name: 'role wake',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action: { type: 'role-wake', roleId: 'role-a' },
    runsOn: 'local',
    enabled: false,
    maxRetries: 0,
    retryDelay: 5_000,
    timeout: 60_000,
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW,
  };
}

function execution(id: string, scheduledAt: number, cost?: number): CronJobExecution {
  return {
    id,
    jobId: 'job-w1',
    runsOn: 'local',
    status: 'completed',
    scheduledAt,
    startedAt: scheduledAt,
    completedAt: scheduledAt + 1_000,
    duration: 1_000,
    retryAttempt: 0,
    ...(cost !== undefined ? { cost } : {}),
  };
}

describe('getJobExecutions 短缓存不能截断历史（N-CRON-RUN-LEDGER-VISIBLE rework）', () => {
  beforeEach(async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        runs_on TEXT NOT NULL,
        max_run_budget REAL,
        max_runs INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        min_interval_seconds INTEGER NOT NULL DEFAULT 60,
        result_channel TEXT,
        cloud_job_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER,
        retry_delay INTEGER,
        timeout INTEGER,
        tags TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cron_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration INTEGER,
        result TEXT,
        error TEXT,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        trigger_json TEXT,
        cost_usd REAL
      );
    `);
    databaseState.db = db;
    await saveCronJob(localJob());
    await saveCronExecution(execution('e1', NOW, 0.0123));
    await saveCronExecution(execution('e6', NOW - DAY, 0.0087));
    await saveCronExecution(execution('e7', NOW - DAY - 3_600_000, 0.002));
  });

  afterEach(() => {
    databaseState.db?.close();
    databaseState.db = null;
  });

  it('getJobExecutions(jobId, 1) 之后 getJobExecutions(jobId, 20) 返回全部 3 条', () => {
    const service = new CronService();
    const latest = service.getJobExecutions('job-w1', 1);
    expect(latest.map((row) => row.id)).toEqual(['e1']);

    const history = service.getJobExecutions('job-w1', 20);
    expect(history).toHaveLength(3);
    expect(history.map((row) => row.id)).toEqual(['e7', 'e6', 'e1']);
    expect(history.map((row) => row.cost)).toEqual([0.002, 0.0087, 0.0123]);
    // 历史读取不把库里的旧行灌进内存尾部（连败计数只看本进程推进过的记录）。
    expect(service.getStats().totalExecutions).toBe(1);
  });

  it('窗口回库时仍保留只存在于内存的刚结束运行', () => {
    const service = new CronService();
    service.getJobExecutions('job-w1', 1);
    const live = execution('e-live', NOW + 60_000, 0.5);
    const executions = (service as unknown as {
      executions: Map<string, CronJobExecution[]>;
    }).executions;
    executions.get('job-w1')!.push(live);

    const history = service.getJobExecutions('job-w1', 20);
    expect(history.map((row) => row.id)).toEqual(['e7', 'e6', 'e1', 'e-live']);
    expect(history[3]).toBe(live);
    expect(service.getStats().totalExecutions).toBe(2);
  });
});
