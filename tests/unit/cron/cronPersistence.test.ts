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

import { saveCronJob } from '../../../src/host/cron/cronPersistence';
import { normalizeCronJobRow } from '../../../src/host/cron/cronNormalizers';

describe('cronPersistence', () => {
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
        max_runs INTEGER CHECK (max_runs IS NULL OR max_runs >= 1),
        run_count INTEGER NOT NULL DEFAULT 0,
        min_interval_seconds INTEGER NOT NULL,
        result_channel TEXT,
        cloud_job_id TEXT,
        enabled INTEGER NOT NULL,
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
        status TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
      );
    `);
    databaseState.db = db;
  });

  afterEach(() => {
    databaseState.db?.close();
    databaseState.db = null;
  });

  it('重存同一 job 时保留执行历史', async () => {
    const original = {
      id: 'cron-1',
      name: 'Original job',
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
      action: { type: 'shell' as const, command: 'echo first' },
      runsOn: 'local' as const,
      enabled: true,
      maxRetries: 0,
      retryDelay: 5_000,
      timeout: 60_000,
      createdAt: 100,
      updatedAt: 100,
    };

    await saveCronJob(original);
    databaseState.db?.prepare(`
      INSERT INTO cron_executions (id, job_id, status, scheduled_at)
      VALUES (?, ?, ?, ?)
    `).run('execution-1', original.id, 'completed', 150);

    await saveCronJob({
      ...original,
      name: 'Updated job',
      action: { type: 'shell', command: 'echo updated' },
      updatedAt: 200,
    });

    expect(databaseState.db?.prepare(
      'SELECT name, updated_at FROM cron_jobs WHERE id = ?',
    ).get(original.id)).toEqual({ name: 'Updated job', updated_at: 200 });
    expect(databaseState.db?.prepare(
      'SELECT id, status FROM cron_executions WHERE job_id = ?',
    ).all(original.id)).toEqual([{ id: 'execution-1', status: 'completed' }]);
  });

  it('maxRuns/runCount round-trip through save and load', async () => {
    const job = {
      id: 'cron-limited',
      name: 'Limited job',
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
      action: { type: 'shell' as const, command: 'echo ok' },
      runsOn: 'local' as const,
      enabled: true,
      maxRunBudget: 0.5,
      maxRuns: 3,
      runCount: 2,
      createdAt: 100,
      updatedAt: 100,
    };

    await saveCronJob(job);
    const loaded = normalizeCronJobRow(
      databaseState.db?.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(job.id),
    );
    expect(loaded).toMatchObject({ maxRunBudget: 0.5, maxRuns: 3, runCount: 2 });

    // 未设置时：maxRuns 回 undefined（不设限），run_count 落库默认 0。
    await saveCronJob({ ...job, id: 'cron-unlimited', maxRunBudget: undefined, maxRuns: undefined, runCount: undefined });
    const unlimited = normalizeCronJobRow(
      databaseState.db?.prepare('SELECT * FROM cron_jobs WHERE id = ?').get('cron-unlimited'),
    );
    expect(unlimited).toMatchObject({ maxRunBudget: undefined, maxRuns: undefined, runCount: 0 });
  });

  it('rejects a maxRuns below 1 at the database CHECK constraint', async () => {
    const job = {
      id: 'cron-invalid',
      name: 'Invalid limited job',
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
      action: { type: 'shell' as const, command: 'echo ok' },
      runsOn: 'local' as const,
      enabled: true,
      maxRuns: 0,
      createdAt: 100,
      updatedAt: 100,
    };

    // saveCronJob 吞错只记日志：约束拒绝后行不存在即为护栏生效。
    await saveCronJob(job);
    expect(databaseState.db?.prepare('SELECT id FROM cron_jobs WHERE id = ?').get(job.id)).toBeUndefined();
  });
});
