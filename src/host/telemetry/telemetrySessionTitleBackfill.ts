// ============================================================================
// N-TELEMETRY-SESSION-TITLE-STALE — 遥测会话标题回填
// ----------------------------------------------------------------------------
// telemetry_sessions.title 历史上只存开会话那刻的占位快照（'CLI Session' /
// 首条消息前 80 字），模型自动起的标题和用户改名只写 sessions.title。本模块在
// 启动维护期用 sessions.title 幂等回填遥测表：已一致的行不动，sessions 侧仍是
// 占位命名的行也不动（别拿 'New Chat' 砸掉遥测里的首条消息快照）。
// 写入与在线同步同一道 guardTelemetryText 口径。
// ============================================================================

import type Database from 'better-sqlite3';
import { createLogger } from '../services/infra/logger';
import { guardTelemetryText } from './telemetryStorageParsers';

const logger = createLogger('TelemetryBackfill');

/** 会话还没被命过名的占位档；同族判定见 sessionManager.isDefaultSessionTitle /
 *  cli/session.ts maybeUpdateTitle / webSessionStore.isDefaultSessionTitle，
 * 这里取并集（含 CLI 占位），因为它要同时面对两端写下的行。 */
function isDefaultChatTitle(title: string | null | undefined): boolean {
  const named = title?.trim();
  return !named
    || named === 'New Chat'
    || named === 'New Session'
    || named === '新对话'
    || named === 'CLI Session'
    || named.startsWith('Session ')
    || named.startsWith('CLI Session ');
}

/** 首次建遥测行时读 sessions.title：已命名才返回，占位/空白/无行都当没有。 */
export function readNamedChatTitle(db: Database.Database, sessionId: string): string | null {
  try {
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined;
    const named = row?.title?.trim();
    if (!named || isDefaultChatTitle(named)) return null;
    return named;
  } catch {
    return null;
  }
}

/**
 * 只读 sessions.title 写遥测表，幂等。返回本次更新的行数（0 = 全一致或无可回填）。
 * fail-safe：回填失败不阻塞启动。
 */
export function backfillTelemetrySessionTitles(db: Database.Database): number {
  try {
    const rows = db.prepare(`
      SELECT t.id AS id, t.title AS telemetry_title, s.title AS chat_title
      FROM telemetry_sessions t
      JOIN sessions s ON s.id = t.id
    `).all() as Array<{ id: string; telemetry_title: string | null; chat_title: string | null }>;

    const update = db.prepare('UPDATE telemetry_sessions SET title = ? WHERE id = ?');
    let updated = 0;
    db.transaction(() => {
      for (const row of rows) {
        if (isDefaultChatTitle(row.chat_title)) continue;
        const guarded = guardTelemetryText(row.chat_title, 2_000);
        if (!guarded || guarded === row.telemetry_title) continue;
        update.run(guarded, row.id);
        updated += 1;
      }
    })();
    if (updated > 0) {
      logger.info(`Backfilled ${updated} telemetry session title(s) from sessions.title`);
    }
    return updated;
  } catch (error) {
    logger.warn('Telemetry session title backfill failed (ignored):', error);
    return 0;
  }
}
