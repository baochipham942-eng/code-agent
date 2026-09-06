// ============================================================================
// LoopStartupRecovery — 启动时把残留 running loop 收口成终态（N-LOOP-DURABLE 刀1）
//
// LoopController 的 loops 是内存 Map，App 更新 / 崩溃 / 关机后循环直接蒸发；
// 而 session_automations 里那条 status='running' 的记录还躺在 SQLite 里
// （台账只持久化终态任务，running 的 loop 从不落 background_task_terminal_tasks，
// 残留的真源是 session_automations 表）。侧栏徽标会继续谎报「运行中」。
//
// 本模块在进程启动时扫这张表，把 type='loop' 且 status='running' 的残留行：
//   1. automation 记录收成终态（桌面路径经 recordEvent 顺带把中断写回源会话）；
//   2. 台账补一条 orphaned 终态任务（复用 shell/pty/cron 重启恢复的同一终态，
//      不新造枚举），并经 queueNotification 发一条人话通知。
// 只收口、不恢复续跑（恢复是刀2 的 loop_runs 表的事）。轮次不落库，取不到就不编。
//
// 修复棒 Important 1：CLI 与桌面共用同一个 code-agent.db 且会并发运行，
// 「本进程启动 = 上一个进程死了」这个前提不成立（cron 的 markInterruptedExecutions
// 同款前提在 loop 这里必须收紧）。因此只收口**归属进程已确认消失**的记录：
// loop 进入 running 时盖的进程归属戳（pid + 进程启动时间，见 loopOwnership.ts），
// 收口时逐条判活——pid 不在（或已被复用）才动手；判不出归属（无戳/戳不合法）
// 保持原样不动，宁可漏收，不可误杀（误杀 = 当着用户面把还在跑的 loop 谎报成失败）。
// 判据修在本函数内部，调用方（webServer / initializeCLIServices 的任何 CLI 入口）
// 无需也不会再靠「挑对启动时机」来保安全。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { LOOP_TASK_KIND } from '../../shared/contract/loop';
import { getBackgroundTaskLedger } from '../task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../task/backgroundTaskStore';
import { getDatabase } from '../services/core/databaseService';
import { getSessionAutomationService } from '../services/sessionAutomation';
import { createLogger } from '../services/infra/logger';
import { parseLoopOwnerStamp, resolveLoopOwnerLiveness, stripLoopOwnerStamp } from './loopOwnership';

const logger = createLogger('LoopStartupRecovery');

const LOST_SUMMARY = '应用关闭时中断，未能继续';

interface InterruptedLoopRow {
  id: string;
  source_session_id: string | null;
  title: string;
  source_ref_id?: string | null;
  config_json?: string | null;
  created_at: number;
  last_run_at?: number | null;
}

function hasSessionAutomationsTable(db: BetterSqlite3.Database): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_automations' LIMIT 1
  `).get() as { name?: string } | undefined;
  return row?.name === 'session_automations';
}

/**
 * 把残留的 running loop 收口成终态并通知。幂等：已收口的行不再命中 status='running'。
 * 只收口归属进程已确认消失的行（Important 1）。
 * @param db 数据库句柄；缺省用桌面 DatabaseService 单例（CLI serve 等无该单例的面显式传入）。
 * @returns 本次收口的 loop 条数（0 = 无残留 / 归属还在 / 库不可用，均不算错误）。
 */
export async function markInterruptedLoops(db?: BetterSqlite3.Database | null): Promise<number> {
  try {
    const handle = db ?? getDatabase().getDb();
    if (!handle || !hasSessionAutomationsTable(handle)) return 0;

    const rows = handle.prepare(`
      SELECT id, source_session_id, title, source_ref_id, config_json, created_at, last_run_at
      FROM session_automations
      WHERE type = 'loop' AND status = 'running'
      ORDER BY created_at ASC
    `).all() as InterruptedLoopRow[];
    if (rows.length === 0) return 0;

    // 台账终态 + 通知必须落库：启动期 ledger 还没挂 store（IPC 首次调用才挂），
    // 不挂上的话通知只存在内存里，进程再退出一次就又蒸发了。
    const ledger = getBackgroundTaskLedger();
    ledger.setStore(new SqliteBackgroundTaskStore(handle));

    const now = Date.now();
    let marked = 0;
    let skippedAlive = 0;
    let skippedUnowned = 0;
    for (const row of rows) {
      const liveness = resolveLoopOwnerLiveness(parseLoopOwnerStamp(row.config_json));
      if (liveness !== 'dead') {
        if (liveness === 'alive') skippedAlive += 1;
        else skippedUnowned += 1;
        continue;
      }
      if (await finalizeInterruptedLoop(handle, row, now)) marked += 1;
    }
    logger.info(
      `Marked ${marked} interrupted loop(s) as lost at startup`
      + ` (skipped: ${skippedAlive} live-owner, ${skippedUnowned} unowned/legacy)`,
    );
    return marked;
  } catch (error) {
    logger.warn('markInterruptedLoops failed:', error);
    return 0;
  }
}

async function finalizeInterruptedLoop(
  db: BetterSqlite3.Database,
  row: InterruptedLoopRow,
  now: number,
): Promise<boolean> {
  // 桌面路径：recordEvent 收口记录 + 把中断写成源会话里的 isMeta 回流消息。
  // CLI serve 没有 host DatabaseService 单例，getById 查不到 → 回落为只改行。
  const automation = getSessionAutomationService().getById(row.id);
  let finalized = false;
  if (automation) {
    const recorded = await getSessionAutomationService().recordEvent({
      automationId: row.id,
      event: 'failed',
      status: 'failed',
      recordStatus: 'failed',
      summary: LOST_SUMMARY,
      eventId: `lost:${row.id}:${now}`,
      lastRunAt: row.last_run_at ?? undefined,
    }).catch((error: unknown) => {
      logger.warn(`recordEvent failed for ${row.id}:`, error);
      return null;
    });
    finalized = recorded !== null;
  }
  if (!finalized) {
    db.prepare(`
      UPDATE session_automations
      SET status = 'failed', config_json = ?, updated_at = ?
      WHERE id = ?
    `).run(stripLoopOwnerStamp(row.config_json), now, row.id);
  }

  const taskId = row.source_ref_id || row.id.replace(/^loop:/, '');
  const ledger = getBackgroundTaskLedger();
  try {
    ledger.upsertTask({
      id: taskId,
      kind: LOOP_TASK_KIND,
      source: LOOP_TASK_KIND,
      sessionId: row.source_session_id ?? undefined,
      title: row.title,
      status: 'orphaned',
      createdAt: row.created_at,
      startedAt: row.created_at,
      completedAt: now,
      durationMs: Math.max(0, now - row.created_at),
      summary: LOST_SUMMARY,
      failure: { message: 'Loop was interrupted by app restart', category: 'interrupted_by_restart' },
      metadata: { loopId: taskId, originalStatus: 'running', lostAt: now },
    });
    if (row.source_session_id) {
      ledger.queueNotification({
        id: `${taskId}:lost`,
        taskId,
        sessionId: row.source_session_id,
        type: 'task_failed',
        title: row.title,
        message: `${row.title} 在应用关闭时中断，未能继续`,
      });
    }
  } catch (error) {
    logger.warn(`finalize ledger task failed for ${taskId}:`, error);
  }
  return true;
}
