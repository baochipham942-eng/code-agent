import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

// ============================================================================
// Cloud cron schedules schema — ADR-087 S4（方案 B：账本排程）. DDL only,
// 同 schemaCloudRunLedger 形状。
// - 一行 = (account_id, job_id) 的一张云端定时声明；schedule_json/request_json
//   存声明原样，到点解释权在 CloudCronScheduler。
// - next_run_at 是 tick 的到期索引；last_slot 只是最近一次已 admit 的计划时刻，
//   供排查重复触发，不参与唯一性 —— 唯一性的事实源是 cloud_runs 上的幂等键。
// - enabled=0 或 next_run_at IS NULL 的行永不进到期扫描（partial index 只盖到期路径）。
// ============================================================================

export function applyCloudCronSchedulesSchema(db: BetterSqlite3.Database, _logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_cron_schedules (
      account_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      next_run_at INTEGER,
      last_slot INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, job_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_cron_schedules_due
      ON cloud_cron_schedules (next_run_at)
      WHERE enabled = 1 AND next_run_at IS NOT NULL;
  `);
}
