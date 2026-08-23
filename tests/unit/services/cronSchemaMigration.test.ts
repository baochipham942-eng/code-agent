import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

describe('cron_jobs execution-location migration', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER DEFAULT 0,
        retry_delay INTEGER DEFAULT 5000,
        timeout INTEGER DEFAULT 60000,
        tags TEXT,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO cron_jobs (
        id, name, schedule_type, schedule, action, created_at, updated_at
      ) VALUES (
        'legacy-job', 'Legacy local job', 'every',
        '{"type":"every","interval":5,"unit":"minutes"}',
        '{"type":"shell","command":"echo ok"}', 1, 1
      );
    `);
  });

  afterEach(() => db.close());

  it('upgrades a legacy table and backfills existing jobs as local', () => {
    applySchema(db, noopLogger);

    const columns = db.pragma('table_info(cron_jobs)') as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'runs_on',
      'max_run_budget',
      'min_interval_seconds',
    ]));
    expect(db.prepare(`
      SELECT runs_on, max_run_budget, min_interval_seconds
      FROM cron_jobs WHERE id = 'legacy-job'
    `).get()).toEqual({
      runs_on: 'local',
      max_run_budget: null,
      min_interval_seconds: 60,
    });
  });
});
