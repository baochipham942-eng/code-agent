import { getDatabase } from '../core/databaseService';

function getDb() {
  return getDatabase().getDb();
}

export interface DistillSignalRecordResult {
  distinctSessionCount: number;
  inserted: boolean;
}

/** Persist one signal per pattern/session and return its distinct-session frequency. */
export function recordDistillSignal(input: {
  patternKey: string;
  sessionId: string;
  createdAt?: number;
}): DistillSignalRecordResult | null {
  const db = getDb();
  if (!db) return null;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO distill_signals (pattern_key, session_id, created_at)
    VALUES (?, ?, ?)
  `).run(input.patternKey, input.sessionId, input.createdAt ?? Date.now());

  const row = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS count
    FROM distill_signals
    WHERE pattern_key = ?
  `).get(input.patternKey) as { count: number } | undefined;
  return {
    distinctSessionCount: row?.count ?? 0,
    inserted: insert.changes > 0,
  };
}

export function hasDistillSuggestionForSession(sessionId: string): boolean {
  const db = getDb();
  if (!db) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM distill_suggestions WHERE session_id = ? LIMIT 1
  `).get(sessionId));
}

export function recordDistillSuggestion(input: {
  id: string;
  patternKey: string;
  sessionId: string;
  createdAt?: number;
}): void {
  const db = getDb();
  if (!db) return;
  db.prepare(`
    INSERT OR IGNORE INTO distill_suggestions (id, pattern_key, session_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(input.id, input.patternKey, input.sessionId, input.createdAt ?? Date.now());
}
