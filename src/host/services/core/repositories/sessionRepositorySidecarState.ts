// ============================================================================
// SessionRepository sidecar state — 会话旁路状态读写
// （todos / session_tasks / session_task_events / context_interventions /
//  session_runtime_state 五张表的纯 SQL 逻辑，从 SessionRepository god-file 抽出）
//
// 行为零改动：每个函数等价于原 SessionRepository 上的同名方法，只是把
// `this.db` 提成首参 `db`。SessionRepository 保留同名薄委托方法。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { TodoItem, SessionTask } from '../../../../shared/contract';
import type { ContextInterventionAction, ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import { safeJsonStringify, parseJsonArray, parseJsonObject } from './sessionRepositoryParsers';

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

// --------------------------------------------------------------------------
// Todos
// --------------------------------------------------------------------------

export function saveTodos(
  db: BetterSqlite3.Database,
  sessionId: string,
  todos: TodoItem[],
  updatedAt?: number,
): void {
  const now = updatedAt ?? Date.now();

  const saveFn = db.transaction(() => {
    db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);

    const stmt = db.prepare(`
      INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const todo of todos) {
      stmt.run(sessionId, todo.content, todo.status, todo.activeForm, now, now);
    }
  });

  saveFn();
}

export function getTodos(db: BetterSqlite3.Database, sessionId: string): TodoItem[] {
  const stmt = db.prepare(`
    SELECT content, status, active_form FROM todos
    WHERE session_id = ?
    ORDER BY id ASC
  `);

  const rows = stmt.all(sessionId) as SQLiteRow[];

  return rows.map(
    (row): TodoItem => ({
      content: row.content as string,
      status: row.status as TodoItem['status'],
      activeForm: row.active_form as string,
    }),
  );
}

// --------------------------------------------------------------------------
// Session Tasks
// --------------------------------------------------------------------------

export function saveSessionTasks(
  db: BetterSqlite3.Database,
  sessionId: string,
  tasks: SessionTask[],
  updatedAt?: number,
): void {
  const now = updatedAt ?? Date.now();

  const saveFn = db.transaction(() => {
    db.prepare('DELETE FROM session_tasks WHERE session_id = ?').run(sessionId);

    const stmt = db.prepare(`
      INSERT INTO session_tasks (
        session_id, task_id, subject, description, active_form, status, priority, owner,
        parent_task_id, blocks_json, blocked_by_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const task of tasks) {
      stmt.run(
        sessionId,
        task.id,
        task.subject,
        task.description,
        task.activeForm,
        task.status,
        task.priority,
        task.owner ?? null,
        task.parentTaskId ?? null,
        safeJsonStringify(task.blocks ?? []),
        safeJsonStringify(task.blockedBy ?? []),
        safeJsonStringify(task.metadata ?? {}),
        task.createdAt,
        task.updatedAt || now,
      );
    }
  });

  saveFn();
}

export function getSessionTasks(db: BetterSqlite3.Database, sessionId: string): SessionTask[] {
  const stmt = db.prepare(`
    SELECT task_id, subject, description, active_form, status, priority, owner,
           parent_task_id, blocks_json, blocked_by_json, metadata_json, created_at, updated_at
    FROM session_tasks
    WHERE session_id = ?
    ORDER BY created_at ASC, task_id ASC
  `);

  const rows = stmt.all(sessionId) as SQLiteRow[];

  return rows.map(
    (row): SessionTask => ({
      id: String(row.task_id),
      subject: String(row.subject ?? ''),
      description: String(row.description ?? ''),
      activeForm: String(row.active_form ?? ''),
      status: row.status as SessionTask['status'],
      priority: row.priority as SessionTask['priority'],
      owner: row.owner == null ? undefined : String(row.owner),
      parentTaskId: row.parent_task_id == null ? undefined : String(row.parent_task_id),
      blocks: parseJsonArray(row.blocks_json),
      blockedBy: parseJsonArray(row.blocked_by_json),
      metadata: parseJsonObject(row.metadata_json),
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    }),
  );
}

/**
 * Session Task 事件日志追加（roadmap 2.6，append-only 审计）。
 */
export function appendSessionTaskEvents(
  db: BetterSqlite3.Database,
  events: Array<{
    sessionId: string;
    taskId: string;
    at: number;
    kind: string;
    summary?: string;
    actor?: string;
  }>,
): void {
  if (events.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO session_task_events (session_id, task_id, at, kind, summary, actor)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    stmt.run(event.sessionId, event.taskId, event.at, event.kind, event.summary ?? null, event.actor ?? null);
  }
}

export function getSessionTaskEvents(
  db: BetterSqlite3.Database,
  sessionId: string,
  options: { taskId?: string; limit?: number } = {},
): Array<{
  taskId: string;
  at: number;
  kind: string;
  summary?: string;
  actor?: string;
}> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const params: unknown[] = [sessionId];
  let where = 'session_id = ?';
  if (options.taskId) {
    where += ' AND task_id = ?';
    params.push(options.taskId);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `
    SELECT task_id, at, kind, summary, actor FROM session_task_events
    WHERE ${where}
    ORDER BY at DESC, id DESC
    LIMIT ?
  `,
    )
    .all(...params) as SQLiteRow[];
  return rows.reverse().map((row) => ({
    taskId: String(row.task_id),
    at: Number(row.at),
    kind: String(row.kind),
    ...(row.summary != null ? { summary: String(row.summary) } : {}),
    ...(row.actor != null ? { actor: String(row.actor) } : {}),
  }));
}

/**
 * 事件历史里出现过的最大顶层任务 id（含已删任务）。
 * 单条 SQL 全量聚合——避免 getSessionTaskEvents 的 limit 钳制在长会话里
 * 漏掉早期已删 id 导致复用（Codex R2 MED）。
 */
export function getMaxTopLevelTaskIdFromEvents(db: BetterSqlite3.Database, sessionId: string): number {
  try {
    const row = db
      .prepare(
        `
      SELECT MAX(CAST(
        CASE WHEN instr(task_id, '.') > 0
             THEN substr(task_id, 1, instr(task_id, '.') - 1)
             ELSE task_id END AS INTEGER)) AS max_top
      FROM session_task_events
      WHERE session_id = ?
    `,
      )
      .get(sessionId) as { max_top: number | null } | undefined;
    return Number(row?.max_top ?? 0) || 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------------------
// Context Interventions
// --------------------------------------------------------------------------

export function saveContextIntervention(
  db: BetterSqlite3.Database,
  sessionId: string,
  agentId: string | null | undefined,
  messageId: string,
  action: ContextInterventionAction | null,
  updatedAt?: number,
): void {
  const scopedAgentId = agentId?.trim() || 'global';
  if (!action) {
    db.prepare(
      `DELETE FROM context_interventions
        WHERE session_id = ? AND agent_id = ? AND message_id = ?`,
    ).run(sessionId, scopedAgentId, messageId);
    return;
  }

  db.prepare(
    `INSERT OR REPLACE INTO context_interventions (
      session_id, agent_id, message_id, action, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, scopedAgentId, messageId, action, updatedAt ?? Date.now());
}

export function getContextInterventions(
  db: BetterSqlite3.Database,
  sessionId: string,
  agentId?: string | null,
): ContextInterventionSnapshot {
  const scopedAgentId = agentId?.trim() || 'global';
  const rows = db
    .prepare(
      `SELECT message_id, action FROM context_interventions
        WHERE session_id = ? AND agent_id = ?
        ORDER BY updated_at ASC`,
    )
    .all(sessionId, scopedAgentId) as SQLiteRow[];

  const snapshot: ContextInterventionSnapshot = {
    pinned: [],
    excluded: [],
    retained: [],
  };

  for (const row of rows) {
    const id = String(row.message_id);
    if (row.action === 'pin') snapshot.pinned.push(id);
    if (row.action === 'exclude') snapshot.excluded.push(id);
    if (row.action === 'retain') snapshot.retained.push(id);
  }

  return snapshot;
}

// --------------------------------------------------------------------------
// Session Runtime State
// --------------------------------------------------------------------------

export function saveSessionRuntimeState(
  db: BetterSqlite3.Database,
  sessionId: string,
  state: {
    compressionStateJson?: string | null;
    persistentSystemContext?: string[];
  },
  updatedAt?: number,
): void {
  const existing = getSessionRuntimeState(db, sessionId);
  const compressionStateJson =
    state.compressionStateJson !== undefined ? state.compressionStateJson : (existing?.compressionStateJson ?? null);
  const persistentSystemContext =
    state.persistentSystemContext !== undefined
      ? state.persistentSystemContext
      : (existing?.persistentSystemContext ?? []);

  db.prepare(
    `INSERT OR REPLACE INTO session_runtime_state (
      session_id, compression_state_json, persistent_system_context_json, updated_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(sessionId, compressionStateJson, safeJsonStringify(persistentSystemContext), updatedAt ?? Date.now());
}

export function getSessionRuntimeState(
  db: BetterSqlite3.Database,
  sessionId: string,
): {
  compressionStateJson: string | null;
  persistentSystemContext: string[];
} | null {
  const row = db
    .prepare(
      `SELECT compression_state_json, persistent_system_context_json
        FROM session_runtime_state
        WHERE session_id = ?`,
    )
    .get(sessionId) as SQLiteRow | undefined;

  if (!row) return null;

  return {
    compressionStateJson: row.compression_state_json == null ? null : String(row.compression_state_json),
    persistentSystemContext: parseJsonArray(row.persistent_system_context_json),
  };
}
