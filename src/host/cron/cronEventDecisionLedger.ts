// ============================================================================
// Cron event decision ledger (N-TRIGGER-OBSERVE-MODE)
// ----------------------------------------------------------------------------
// 逐事件决策台账：放在执行记录旁边（cron_event_decisions 表，cronPersistence 同款
// 写法），按任务有界——每次写入后只保留该任务最近 N 条（N 缺省
// CRON_EVENT_DECISIONS.DEFAULT_MAX_PER_JOB，可经 maxPerJob 覆盖）。droppedCount 照旧，
// 台账是叠加的。落库失败只记日志，不拖垮执行链。
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { CronEventDecision, CronEventDecisionOutcome } from '../../shared/contract/cron';
import { CRON_EVENT_DECISIONS } from '../../shared/constants';
import { getDatabase } from '../services/core/databaseService';

export type CronEventDecisionInput = Omit<CronEventDecision, 'id' | 'createdAt'> & { createdAt?: number };

export interface CronEventDecisionWriteOptions {
  /** 每任务保留的最近条数；缺省 CRON_EVENT_DECISIONS.DEFAULT_MAX_PER_JOB。 */
  maxPerJob?: number;
  /** 写入时间戳（缺省 Date.now()；同批行共用一个基准、按序 +1 保持顺序）。 */
  now?: number;
}

/** 台账的读写面（CronEventTrigger / 拦截 sink 依赖它；测试可注入内存实现）。 */
export interface CronEventDecisionStore {
  record(rows: readonly CronEventDecisionInput[]): void;
  /** 该 run 已记下的观察档拦截（kind 'action'）条数。 */
  countActionsForRun(runId: string): number;
}

const DECISIONS = new Set<CronEventDecisionOutcome>(['acted', 'would_act', 'ignored', 'dropped', 'unavailable']);

interface DecisionRow {
  id: string;
  job_id: string;
  kind: string;
  event_id: string | null;
  decision: string;
  reason: string;
  run_id: string | null;
  tool: string | null;
  target: string | null;
  summary: string | null;
  created_at: number;
}

function rowToDecision(row: DecisionRow): CronEventDecision | null {
  if (row.kind !== 'event' && row.kind !== 'action') return null;
  if (!DECISIONS.has(row.decision as CronEventDecisionOutcome)) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    ...(row.event_id ? { eventId: row.event_id } : {}),
    decision: row.decision as CronEventDecisionOutcome,
    reason: row.reason,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.tool ? { tool: row.tool } : {}),
    ...(row.target ? { target: row.target } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    createdAt: row.created_at,
  };
}

export function recordCronEventDecisions(
  rows: readonly CronEventDecisionInput[],
  options: CronEventDecisionWriteOptions = {},
): void {
  if (rows.length === 0) return;
  try {
    const db = getDatabase().getDb();
    if (!db) return;
    const base = options.now ?? Date.now();
    const maxPerJob = Math.max(1, Math.floor(options.maxPerJob ?? CRON_EVENT_DECISIONS.DEFAULT_MAX_PER_JOB));
    const insert = db.prepare(`
      INSERT INTO cron_event_decisions
      (id, job_id, kind, event_id, decision, reason, run_id, tool, target, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const trim = db.prepare(`
      DELETE FROM cron_event_decisions
      WHERE job_id = ? AND id NOT IN (
        SELECT id FROM cron_event_decisions WHERE job_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      )
    `);
    db.transaction(() => {
      rows.forEach((row, index) => {
        insert.run(
          uuidv4(), row.jobId, row.kind, row.eventId ?? null, row.decision, row.reason,
          row.runId ?? null, row.tool ?? null, row.target ?? null, row.summary ?? null,
          row.createdAt ?? base + index,
        );
      });
      for (const jobId of new Set(rows.map((row) => row.jobId))) trim.run(jobId, jobId, maxPerJob);
    })();
  } catch (error) {
    console.error('[CronService] Failed to record event decisions:', error);
  }
}

/** 某自动化最近 limit 条决策，新的在前。 */
export function loadCronEventDecisions(jobId: string, limit: number = CRON_EVENT_DECISIONS.DEFAULT_MAX_PER_JOB): CronEventDecision[] {
  try {
    const db = getDatabase().getDb();
    if (!db) return [];
    const bounded = Math.min(Math.max(1, Math.floor(limit)), CRON_EVENT_DECISIONS.MAX_READ_LIMIT);
    const rows = db.prepare(`
      SELECT * FROM cron_event_decisions WHERE job_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(jobId, bounded) as DecisionRow[];
    return rows.map(rowToDecision).filter((row): row is CronEventDecision => row !== null);
  } catch (error) {
    console.error('[CronService] Failed to load event decisions:', error);
    return [];
  }
}

export function countCronObserveActionsForRun(runId: string): number {
  try {
    const db = getDatabase().getDb();
    if (!db) return 0;
    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM cron_event_decisions WHERE run_id = ? AND kind = 'action'",
    ).get(runId) as { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : 0;
  } catch (error) {
    console.error('[CronService] Failed to count observe actions for run:', error);
    return 0;
  }
}

export const sqliteCronEventDecisionStore: CronEventDecisionStore = {
  record: (rows) => recordCronEventDecisions(rows),
  countActionsForRun: countCronObserveActionsForRun,
};
