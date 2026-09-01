import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';

import type { ConversationBoundary } from '../../../../shared/contract/conversationBranch';
import { sanitizeConversationMessageSnapshot } from '../conversationMessageSnapshot';
import { ConversationBranchRepository } from './ConversationBranchRepository';
import { rowToMessage } from './sessionRepositoryParsers';

type SQLiteRow = Record<string, unknown>;

export function clearAllMessagesWithLedger(
  db: BetterSqlite3.Database,
  branchRepo: ConversationBranchRepository | null,
  readBoundary: (sessionId: string) => ConversationBoundary,
): number {
  const clear = db.transaction(() => {
    let cleared: number;
    if (branchRepo) {
      const sessions = db.prepare(`
        SELECT session_id, COUNT(*) AS message_count
        FROM messages
        GROUP BY session_id
        ORDER BY session_id ASC
      `).all() as Array<{ session_id: string; message_count: number }>;
      cleared = db.prepare('DELETE FROM messages').run().changes;
      for (const session of sessions) {
        const latest = db.prepare(`
          SELECT COALESCE(MAX(event.sequence), 0) AS sequence
          FROM conversation_branches branch
          LEFT JOIN conversation_branch_events event ON event.branch_id = branch.id
          WHERE branch.session_id = ?
        `).get(session.session_id) as { sequence: number };
        branchRepo.recordProjectionReplacement({
          sessionId: session.session_id,
          boundary: readBoundary(session.session_id),
          messages: [],
          idempotencyKey: `projection-clear-all:${Number(latest.sequence) + 1}:${session.message_count}`,
          reason: 'SessionRepository.clearAllMessages authoritative history clear',
          createdAt: Date.now(),
        });
      }
    } else {
      cleared = db.prepare('DELETE FROM messages').run().changes;
    }
    return cleared;
  });
  return clear();
}

export function reconcileMessageProjectionOrderWithLedger(
  db: BetterSqlite3.Database,
  branchRepo: ConversationBranchRepository | null,
  readBoundary: (sessionId: string) => ConversationBoundary,
  sessionId: string,
  reason: string,
  createdAt: number,
): void {
  if (!branchRepo) return;
  const reconcile = db.transaction(() => {
    const persistedRows = db.prepare(`
      SELECT *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId) as SQLiteRow[];
    const snapshots = persistedRows.map((row) => (
      sanitizeConversationMessageSnapshot(rowToMessage(row))
    ));
    const digest = createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
    branchRepo.recordProjectionReplacement({
      sessionId,
      boundary: readBoundary(sessionId),
      messages: snapshots,
      idempotencyKey: `projection-order-reconcile:${digest}`,
      reason,
      createdAt,
    });
  });
  reconcile();
}
