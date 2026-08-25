import type BetterSqlite3 from 'better-sqlite3';

export interface CrashedActiveSessions {
  interrupted: number;
  orphaned: number;
  sessionIds: string[];
}

export function markCrashedActiveSessions(
  db: BetterSqlite3.Database,
  now: number,
): CrashedActiveSessions {
  const interruptedSessions = db
    .prepare(
      `UPDATE sessions
         SET status = 'interrupted', updated_at = ?, synced_at = NULL
       WHERE status IN ('running', 'paused', 'cancelling') AND is_deleted = 0
       RETURNING id`,
    )
    .all(now) as Array<{ id: string }>;

  const orphanedSessions = db
    .prepare(
      `UPDATE sessions
         SET status = 'orphaned', updated_at = ?, synced_at = NULL
       WHERE status = 'queued' AND is_deleted = 0
       RETURNING id`,
    )
    .all(now) as Array<{ id: string }>;

  return {
    interrupted: interruptedSessions.length,
    orphaned: orphanedSessions.length,
    sessionIds: [...interruptedSessions, ...orphanedSessions].map(({ id }) => id),
  };
}
