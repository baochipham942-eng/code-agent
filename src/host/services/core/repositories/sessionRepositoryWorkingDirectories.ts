// ============================================================================
// SessionRepository working directories — 懒开目录撞名判定的名字占用查询
//（N-DELIVERABLE-WORKDIR-LAZY rework r2）
//
// 从 SessionRepository god-file 独立成助手而不是加薄委托：该文件已顶在 max-lines
// 1000 上，任何净增长都会红。调用方是 DatabaseService 门面（该文件在豁免名单），
// SessionRepository 不暴露此查询。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';

type SQLiteRow = Record<string, unknown>;

/**
 * 所有未删除会话行已记下的工作目录（DISTINCT）。懒开目录撞名判定把它当占用集：
 * 纯问答会话的规划路径只存在于会话行、盘上永不出现。exceptSessionId 用于排除某
 * 会话自己的占用（重规划/撞名改道时不想被自己挡）。db 为 null（未初始化）时按
 * 无占用返回——调用方（DatabaseService 门面）先过 ensureDb，这里是兜底。
 */
export function listRecordedWorkingDirectories(
  db: BetterSqlite3.Database | null,
  exceptSessionId?: string,
): string[] {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT DISTINCT working_directory
    FROM sessions
    WHERE is_deleted = 0
      AND working_directory IS NOT NULL
      AND TRIM(working_directory) <> ''
      AND (? IS NULL OR id != ?)
  `);
  const rows = stmt.all(exceptSessionId ?? null, exceptSessionId ?? null) as SQLiteRow[];
  return rows.map((row) => String(row.working_directory));
}
