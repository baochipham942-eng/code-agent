// ============================================================================
// sessionRepositoryBoundary - 会话边界读取与 fork 保护投影（自 SessionRepository 拆出）
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { Message } from '../../../../shared/contract';
import {
  ConversationBranchError,
  type ConversationBoundary,
} from '../../../../shared/contract/conversationBranch';

function sqliteTableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

export function readConversationBoundary(
  db: BetterSqlite3.Database,
  sessionsHaveProjectId: boolean,
  sessionId: string,
): ConversationBoundary {
  const row = db.prepare(`
      SELECT user_id, ${sessionsHaveProjectId ? 'project_id' : 'NULL AS project_id'}
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as { user_id: string | null; project_id: string | null } | undefined;
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  return {
    ownerUserId: typeof row.user_id === 'string' ? row.user_id : null,
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
  };
}

export function assertRemoteSessionBoundaryCompatible(
  db: BetterSqlite3.Database,
  sessionId: string,
  incoming: ConversationBoundary,
): void {
  if (!sqliteTableExists(db, 'conversation_branches')) return;
  const branch = db.prepare(`
      SELECT id, owner_user_id, project_id
      FROM conversation_branches
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId) as {
      id: string;
      owner_user_id: string | null;
      project_id: string | null;
    } | undefined;
  if (!branch) return;
  if (branch.owner_user_id !== incoming.ownerUserId) {
    throw new ConversationBranchError(
      'OWNER_MISMATCH',
      `remote session ${sessionId} cannot change immutable branch ${branch.id} owner`,
    );
  }
  if (branch.project_id !== incoming.projectId) {
    throw new ConversationBranchError(
      'PROJECT_MISMATCH',
      `remote session ${sessionId} cannot change immutable branch ${branch.id} project`,
    );
  }
}

export function protectedForkMessageIds(db: BetterSqlite3.Database, sessionId: string): Set<string> {
  if (
    !sqliteTableExists(db, 'session_forks')
    || !sqliteTableExists(db, 'session_fork_message_map')
  ) {
    return new Set();
  }
  const rows = db.prepare(`
      SELECT map.source_message_id AS message_id
      FROM session_forks AS fork
      JOIN session_fork_message_map AS map ON map.fork_id = fork.id
      WHERE fork.source_session_id = ?
        AND fork.status IN ('workspace_ready', 'completed')
      UNION
      SELECT map.child_message_id AS message_id
      FROM session_forks AS fork
      JOIN session_fork_message_map AS map ON map.fork_id = fork.id
      WHERE fork.child_session_id = ?
        AND fork.status IN ('workspace_ready', 'completed')
    `).all(sessionId, sessionId) as Array<{ message_id: string }>;
  return new Set(rows.map((row) => String(row.message_id)));
}

export function forkProtectedProjection(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    toolCalls: message.toolCalls ?? null,
    toolResults: message.toolResults ?? null,
    responsesOutput: message.responsesOutput ?? null,
    attachments: message.attachments ?? null,
    thinking: message.thinking ?? message.reasoning ?? null,
    effortLevel: message.effortLevel ?? null,
    contentParts: message.contentParts ?? null,
    metadata: message.metadata ?? null,
    isMeta: Boolean(message.isMeta),
    compaction: message.compaction ?? null,
  };
}
