// ============================================================================
// Sync Service - Session 和 Message 同步逻辑
// ============================================================================

import { getDb, type Session, type Message } from './db.js';

export interface SyncSessionRequest {
  id: string;
  title: string;
  generation: number;
  workspacePath?: string;
  config?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SyncMessageRequest {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Record<string, unknown>[];
  createdAt: string;
}

export interface SyncPullResponse {
  sessions: Session[];
  messages: Message[];
  deletedSessionIds: string[];
  serverTime: string;
}

// 批量同步 Sessions
export async function syncSessions(
  userId: string,
  sessions: SyncSessionRequest[]
): Promise<{ synced: number; errors: string[] }> {
  const sql = getDb();
  const errors: string[] = [];
  let synced = 0;

  for (const session of sessions) {
    try {
      await sql`
        INSERT INTO code_agent.sessions (id, user_id, title, generation, workspace_path, config, created_at, updated_at)
        VALUES (
          ${session.id},
          ${userId},
          ${session.title},
          ${session.generation},
          ${session.workspacePath || null},
          ${JSON.stringify(session.config || {})},
          ${session.createdAt},
          ${session.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          generation = EXCLUDED.generation,
          workspace_path = EXCLUDED.workspace_path,
          config = EXCLUDED.config,
          updated_at = EXCLUDED.updated_at
        WHERE code_agent.sessions.updated_at < EXCLUDED.updated_at
      `;
      synced++;
    } catch (error: any) {
      errors.push(`Session ${session.id}: ${error.message}`);
    }
  }

  return { synced, errors };
}

// 批量同步 Messages
export async function syncMessages(
  userId: string,
  messages: SyncMessageRequest[]
): Promise<{ synced: number; errors: string[] }> {
  const sql = getDb();
  const errors: string[] = [];
  let synced = 0;

  for (const message of messages) {
    try {
      // 验证 session 属于当前用户
      const sessionCheck = await sql`
        SELECT id FROM code_agent.sessions
        WHERE id = ${message.sessionId} AND user_id = ${userId}
      `;

      if (sessionCheck.length === 0) {
        errors.push(`Message ${message.id}: Session not found or not owned by user`);
        continue;
      }

      await sql`
        INSERT INTO code_agent.messages (id, session_id, role, content, tool_calls, created_at)
        VALUES (
          ${message.id},
          ${message.sessionId},
          ${message.role},
          ${message.content},
          ${message.toolCalls ? JSON.stringify(message.toolCalls) : null},
          ${message.createdAt}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      synced++;
    } catch (error: any) {
      errors.push(`Message ${message.id}: ${error.message}`);
    }
  }

  return { synced, errors };
}

// 拉取用户的所有数据（或增量）
export async function pullUserData(
  userId: string,
  since?: string
): Promise<SyncPullResponse> {
  const sql = getDb();

  let sessions: Session[];
  let messages: Message[];

  if (since) {
    // 增量同步：只获取指定时间之后更新的数据
    sessions = (await sql`
      SELECT * FROM code_agent.sessions
      WHERE user_id = ${userId} AND updated_at > ${since}
      ORDER BY updated_at DESC
    `) as Session[];

    const sessionIds = sessions.map((s) => s.id);

    if (sessionIds.length > 0) {
      messages = (await sql`
        SELECT * FROM code_agent.messages
        WHERE session_id = ANY(${sessionIds}) AND created_at > ${since}
        ORDER BY created_at ASC
      `) as Message[];
    } else {
      messages = [];
    }
  } else {
    // 全量同步
    sessions = (await sql`
      SELECT * FROM code_agent.sessions
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
    `) as Session[];

    const sessionIds = sessions.map((s) => s.id);

    if (sessionIds.length > 0) {
      messages = (await sql`
        SELECT * FROM code_agent.messages
        WHERE session_id = ANY(${sessionIds})
        ORDER BY created_at ASC
      `) as Message[];
    } else {
      messages = [];
    }
  }

  return {
    sessions,
    messages,
    deletedSessionIds: [], // TODO: 实现软删除追踪
    serverTime: new Date().toISOString(),
  };
}

// 删除 Session（级联删除 Messages）
export async function deleteSession(
  userId: string,
  sessionId: string
): Promise<boolean> {
  const sql = getDb();

  const result = await sql`
    DELETE FROM code_agent.sessions
    WHERE id = ${sessionId} AND user_id = ${userId}
    RETURNING id
  `;

  return result.length > 0;
}

// 获取用户统计信息
export async function getUserStats(userId: string): Promise<{
  sessionCount: number;
  messageCount: number;
  lastSyncAt: string | null;
}> {
  const sql = getDb();

  const sessionCount = await sql`
    SELECT COUNT(*) as count FROM code_agent.sessions WHERE user_id = ${userId}
  `;

  const messageCount = await sql`
    SELECT COUNT(*) as count FROM code_agent.messages m
    JOIN code_agent.sessions s ON m.session_id = s.id
    WHERE s.user_id = ${userId}
  `;

  const lastSession = await sql`
    SELECT updated_at FROM code_agent.sessions
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  return {
    sessionCount: parseInt(sessionCount[0]?.count || '0', 10),
    messageCount: parseInt(messageCount[0]?.count || '0', 10),
    lastSyncAt: lastSession[0]?.updated_at?.toISOString() || null,
  };
}
