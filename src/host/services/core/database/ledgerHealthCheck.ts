// ----------------------------------------------------------------------------
// 账本健康检查（L8 观测批）——fail-loud 但不误报：
// 以「近 7 天存在带工具调用的桌面会话」为独立真源（messages 表，不拿账本自证），
// 交叉两张账本的 desktop-origin 写入；桌面有工具活动而账本为零才 WARN。
// ----------------------------------------------------------------------------

import type { Database } from 'better-sqlite3';
import type { PermissionDecisionRepository } from '../repositories/PermissionDecisionRepository';
import type { ToolExecutionEventRepository } from '../repositories/ToolExecutionEventRepository';

const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface LedgerHealthDeps {
  db: Database;
  toolExecutionEventRepo: ToolExecutionEventRepository;
  permissionDecisionRepo: PermissionDecisionRepository;
  warn: (message: string, data?: unknown) => void;
}

/** 桌面活动的独立真源：消息携带工具调用，且排除 CLI 会话 id 约定前缀。 */
function countDesktopToolActiveSessionsSince(db: Database, since: number): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT m.session_id) AS c FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE m.timestamp >= ? AND m.tool_calls IS NOT NULL AND m.tool_calls != '' AND s.id NOT LIKE 'cli\\_session\\_%' ESCAPE '\\'
  `).get(since) as { c?: number };
  return Number(row?.c ?? 0);
}

/** fail-safe：检查自身失败只 WARN，绝不阻塞启动。 */
export function checkLedgerHealth(deps: LedgerHealthDeps, now: number): void {
  try {
    const since = now - HEALTH_WINDOW_MS;
    const activeDesktopSessions = countDesktopToolActiveSessionsSince(deps.db, since);
    if (activeDesktopSessions === 0) return;
    const executionRows = deps.toolExecutionEventRepo.countByOriginSince('desktop', since);
    const decisionRows = deps.permissionDecisionRepo.countByOriginSince('desktop', since);
    if (executionRows === 0 || decisionRows === 0) {
      deps.warn('[DatabaseService] 账本疑似断流：近 7 天有桌面工具会话，但 desktop-origin 账本写入为零', {
        activeDesktopSessions, executionRows, decisionRows,
      });
    }
  } catch (err) {
    deps.warn('[DatabaseService] 账本健康检查失败（忽略）:', err);
  }
}
