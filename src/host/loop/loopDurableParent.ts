// ============================================================================
// Loop durable parentRunId 解析 — N-LOOP-DURABLE-K2 刀2-b
//
// durable_runs 每个 session 同时只能有一个 parent_run_id IS NULL 的活跃根 run。
// loop 是长寿命 run，必须挂在启动时该 session 当前/最近的前台 run 下面，否则会
// 把后续普通对话 turn 全部顶成 DurableActiveSessionConflictError。
//
// 取不到 → 调用方 fail-closed（D2 拍板），不自动降级 ephemeral。
// ============================================================================

import { getConfiguredApplicationRunRegistry } from '../app/applicationRunRegistry';
import { getDatabase } from '../services/core/databaseService';

export function resolveLoopParentRunId(sessionId: string): string | undefined {
  const live = getConfiguredApplicationRunRegistry()?.getBySessionId(sessionId)?.context.runId?.trim();
  if (live) return live;
  return lookupLatestRootDurableRunId(sessionId);
}

function lookupLatestRootDurableRunId(sessionId: string): string | undefined {
  try {
    const db = getDatabase().getDb();
    if (!db) return undefined;
    const row = db.prepare(`
      SELECT run_id FROM durable_runs
      WHERE session_id = ? AND parent_run_id IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId) as { run_id?: string } | undefined;
    const runId = row?.run_id?.trim();
    return runId || undefined;
  } catch {
    return undefined;
  }
}
