import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

// ============================================================================
// Event automation action mode + decision ledger schema (N-TRIGGER-OBSERVE-MODE)
// ----------------------------------------------------------------------------
// 1. cron_jobs.action_mode：事件自动化的执行档（'observe' | 'auto'）。
//    迁移戳规则（不靠猜）：本列第一次被加上的那一刻（PRAGMA 里还没有它），同一事务内把
//    已存在的 event 任务一律戳成 'auto'——这些是本单之前创建的记录，保持今天的「会真动」
//    行为。列存在之后，event 任务读到 NULL / 非法值一律按 'observe' 处理（fail-closed），
//    新建 event 任务由 CronService.createJob 显式写 'observe'。
// 2. cron_event_decisions：逐事件决策台账，放在执行记录旁边，按任务有界（写入方裁剪）。
// ============================================================================

function hasColumn(db: BetterSqlite3.Database, table: string, column: string): boolean {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

export function applyCronEventDecisionsSchema(db: BetterSqlite3.Database, logger: Logger): void {
  if (!hasColumn(db, 'cron_jobs', 'action_mode')) {
    try {
      db.transaction(() => {
        db.exec("ALTER TABLE cron_jobs ADD COLUMN action_mode TEXT CHECK (action_mode IS NULL OR action_mode IN ('observe', 'auto'))");
        const stamped = db.prepare("UPDATE cron_jobs SET action_mode = 'auto' WHERE schedule_type = 'event'").run();
        if (stamped.changes > 0) {
          logger.info(`[DB] cron_jobs.action_mode added; ${stamped.changes} pre-existing event automation(s) stamped 'auto'`);
        }
      })();
    } catch (err: unknown) {
      logger.warn('[DB] cron_jobs.action_mode migration failed:', err instanceof Error ? err.message : String(err));
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_event_decisions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('event', 'action')),
      event_id TEXT,
      decision TEXT NOT NULL CHECK (decision IN ('acted', 'would_act', 'ignored', 'dropped', 'unavailable')),
      reason TEXT NOT NULL,
      run_id TEXT,
      tool TEXT,
      target TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cron_event_decisions_job
      ON cron_event_decisions (job_id, created_at DESC);
  `);
}
