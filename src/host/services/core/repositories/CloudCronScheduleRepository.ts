// ============================================================================
// CloudCronScheduleRepository — cloud_cron_schedules 持久行（ADR-087 S4）
// ============================================================================
// 同步 SQLite only（CloudRunRepository 形状）。时间戳一律是参数，本层禁裸取
// 当前时间（repositories grep 门）；真钟默认在 CloudCronScheduler。
// 到期判定、missed-slot 合并、幂等键都不在这层：调度器先判，再用本层落行。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

export interface CloudCronScheduleRecord {
  accountId: string;
  jobId: string;
  scheduleJson: string;
  requestJson: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastSlot: number | null;
  createdAt: number;
  updatedAt: number;
}

interface UpsertCloudCronScheduleInput {
  accountId: string;
  jobId: string;
  scheduleJson: string;
  requestJson: string;
  enabled: boolean;
  nextRunAt: number | null;
  now: number;
}

interface AdvanceCloudCronScheduleInput {
  accountId: string;
  jobId: string;
  nextRunAt: number | null;
  enabled: boolean;
  lastSlot: number;
  now: number;
}

function rowToRecord(row: SQLiteRow): CloudCronScheduleRecord {
  return {
    accountId: String(row.account_id),
    jobId: String(row.job_id),
    scheduleJson: String(row.schedule_json),
    requestJson: String(row.request_json),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
    lastSlot: row.last_slot == null ? null : Number(row.last_slot),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class CloudCronScheduleRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 同一 (account_id, job_id) 重报即覆盖声明并重置 last_slot；created_at 不动。 */
  upsertSchedule(input: UpsertCloudCronScheduleInput): CloudCronScheduleRecord {
    this.db.prepare(
      `INSERT INTO cloud_cron_schedules (
        account_id, job_id, schedule_json, request_json, enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, job_id) DO UPDATE SET
        schedule_json = excluded.schedule_json,
        request_json = excluded.request_json,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        last_slot = NULL,
        updated_at = excluded.updated_at`,
    ).run(
      input.accountId,
      input.jobId,
      input.scheduleJson,
      input.requestJson,
      input.enabled ? 1 : 0,
      input.nextRunAt,
      input.now,
      input.now,
    );
    const created = this.getSchedule(input.accountId, input.jobId);
    if (!created) throw new Error('cloud cron schedule upsert did not persist');
    return created;
  }

  getSchedule(accountId: string, jobId: string): CloudCronScheduleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM cloud_cron_schedules WHERE account_id = ? AND job_id = ?')
      .get(accountId, jobId) as SQLiteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** enabled 且 next_run_at 非空且 <= now 的行，按到期时刻升序（同刻按 job_id 定序）。 */
  listDueSchedules(now: number): CloudCronScheduleRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cloud_cron_schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC, job_id ASC`,
      )
      .all(now) as SQLiteRow[];
    return rows.map(rowToRecord);
  }

  /** admit 之后的推进：next_run_at / enabled / last_slot 同写一行（无未来出现即停用）。 */
  advanceSchedule(input: AdvanceCloudCronScheduleInput): void {
    this.db.prepare(
      `UPDATE cloud_cron_schedules
       SET next_run_at = ?, enabled = ?, last_slot = ?, updated_at = ?
       WHERE account_id = ? AND job_id = ?`,
    ).run(
      input.nextRunAt,
      input.enabled ? 1 : 0,
      input.lastSlot,
      input.now,
      input.accountId,
      input.jobId,
    );
  }
}
