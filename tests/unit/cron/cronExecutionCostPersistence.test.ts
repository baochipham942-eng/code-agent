import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));
import {
  loadCronExecutionsByJob,
  loadRecentCronExecutions,
  saveCronExecution,
  saveCronJob,
} from '../../../src/host/cron/cronPersistence';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const NOW = Date.UTC(2026, 9, 26, 8, 0, 0);

function localJob(): Parameters<typeof saveCronJob>[0] {
  return {
    id: 'job-cost-1',
    name: 'metered job',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'agent', agentType: 'default', prompt: 'check' },
    runsOn: 'local',
    enabled: true,
    maxRetries: 0,
    retryDelay: 5_000,
    timeout: 60_000,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseExecution(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: 'exec-cost-1',
    jobId: 'job-cost-1',
    runsOn: 'local',
    status: 'completed',
    scheduledAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 1_000,
    duration: 1_000,
    result: { agentType: 'default', prompt: 'check', result: undefined, sessionId: 's1', costUsd: 0.0123 },
    retryAttempt: 0,
    ...overrides,
  };
}

describe('cron execution cost persistence (N-CRON-RUN-LEDGER-VISIBLE)', () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    databaseState.db?.close();
    databaseState.db = null;
  });

  it('saveCronExecution 落 cost，loadCronExecutionsByJob 原样读回', async () => {
    await saveCronJob(localJob());
    await saveCronExecution(baseExecution({ cost: 0.0123 }));
    const loaded = loadCronExecutionsByJob('job-cost-1', 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].cost).toBeCloseTo(0.0123);
  });

  it('跨任务执行流（loadRecentCronExecutions）同样带回 cost', async () => {
    await saveCronJob(localJob());
    await saveCronExecution(baseExecution({ cost: 0.5 }));
    const recent = loadRecentCronExecutions(10);
    expect(recent[0].cost).toBeCloseTo(0.5);
  });

  it('无模型调用（cost 未写）读回 undefined，不是 0', async () => {
    await saveCronJob(localJob());
    await saveCronExecution(baseExecution({ cost: undefined }));
    const loaded = loadCronExecutionsByJob('job-cost-1', 10);
    expect(loaded[0].cost).toBeUndefined();
  });

  it('同一执行记录重写（重试收尾）保留已记成本', async () => {
    await saveCronJob(localJob());
    const execution = baseExecution({ cost: 0.02 });
    await saveCronExecution(execution);
    execution.status = 'failed';
    execution.error = 'late failure';
    await saveCronExecution(execution);
    const loaded = loadCronExecutionsByJob('job-cost-1', 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].cost).toBeCloseTo(0.02);
    expect(loaded[0].status).toBe('failed');
  });
});
