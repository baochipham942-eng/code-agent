// ============================================================================
// LibraryRepository - 项目资料库条目 + 会话上下文 pin 持久化
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import os from 'os';
import path from 'path';
import type {
  LibraryItem,
  LibraryItemKind,
  LibraryLearnStatus,
  LibraryListOptions,
  SessionContextPin,
} from '@shared/contract/library';
import { isLibraryLearnStatus } from '@shared/contract/library';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';

type SQLiteRow = Record<string, unknown>;

function guardLibraryText(value: string, maxLength: number): string {
  return guardSensitiveText(value, {
    surface: 'knowledge',
    mode: 'local-persist',
    maxLength,
  }).trim();
}

function normalizePathOrUri(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  return path.resolve(expanded);
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToLibraryItem(row: SQLiteRow): LibraryItem {
  return {
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? null,
    title: row.title as string,
    kind: row.kind as LibraryItemKind,
    pathOrUri: row.path_or_uri as string,
    tags: parseJsonArray(row.tags),
    summary: (row.summary as string | null) ?? undefined,
    sourceSessionId: (row.source_session_id as string | null) ?? undefined,
    sourceRoleId: (row.source_role_id as string | null) ?? undefined,
    contentHash: (row.content_hash as string | null) ?? undefined,
    learnStatus: isLibraryLearnStatus(String(row.learn_status ?? ''))
      ? row.learn_status as LibraryLearnStatus
      : 'pending',
    learnError: (row.learn_error as string | null) ?? undefined,
    learnUpdatedAt: (row.learn_updated_at as number | null) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class LibraryRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --- library_items ---

  createItem(item: LibraryItem): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO library_items
        (id, project_id, title, kind, path_or_uri, tags, summary, source_session_id, source_role_id, content_hash,
         learn_status, learn_error, learn_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.projectId,
      guardLibraryText(item.title, 2_000),
      item.kind,
      normalizePathOrUri(item.pathOrUri),
      JSON.stringify(item.tags.map((tag) => guardLibraryText(tag, 500))),
      item.summary ? guardLibraryText(item.summary, 2_000) : null,
      item.sourceSessionId ?? null,
      item.sourceRoleId ?? null,
      item.contentHash ?? null,
      isLibraryLearnStatus(String(item.learnStatus ?? '')) ? item.learnStatus : 'pending',
      item.learnError ? guardLibraryText(item.learnError, 1_000) : null,
      item.learnUpdatedAt ?? null,
      item.createdAt,
      item.updatedAt,
    );
  }

  getItem(id: string): LibraryItem | undefined {
    const row = this.db.prepare('SELECT * FROM library_items WHERE id = ?').get(id) as SQLiteRow | undefined;
    return row ? rowToLibraryItem(row) : undefined;
  }

  listItemsByIds(ids: string[]): LibraryItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM library_items WHERE id IN (${placeholders})`)
      .all(...ids) as SQLiteRow[];
    const byId = new Map(rows.map((row) => [row.id as string, rowToLibraryItem(row)]));
    return ids.map((id) => byId.get(id)).filter((item): item is LibraryItem => item !== undefined);
  }

  listItems(options?: LibraryListOptions): LibraryItem[] {
    let sql = 'SELECT * FROM library_items WHERE 1=1';
    const params: unknown[] = [];

    if (options && 'projectId' in options && options.projectId !== undefined) {
      if (options.projectId === null) {
        sql += ' AND project_id IS NULL';
      } else {
        sql += ' AND project_id = ?';
        params.push(options.projectId);
      }
    }
    if (options?.kind) {
      sql += ' AND kind = ?';
      params.push(options.kind);
    }
    if (options?.tag) {
      // ponytail: JSON LIKE 匹配，条目量走到需要 FTS 时再换
      sql += ' AND tags LIKE ?';
      params.push(`%${JSON.stringify(options.tag)}%`);
    }

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(options?.limit ?? 100, options?.offset ?? 0);

    return (this.db.prepare(sql).all(...params) as SQLiteRow[]).map(rowToLibraryItem);
  }

  updateItem(
    id: string,
    patch: { title?: string; tags?: string[]; summary?: string | null; projectId?: string | null },
    updatedAt: number,
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(guardLibraryText(patch.title, 2_000));
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags.map((tag) => guardLibraryText(tag, 500))));
    }
    if (patch.summary !== undefined) {
      sets.push('summary = ?');
      params.push(patch.summary === null ? null : guardLibraryText(patch.summary, 2_000));
    }
    if (patch.projectId !== undefined) {
      sets.push('project_id = ?');
      params.push(patch.projectId);
    }
    if (sets.length === 0) return false;

    sets.push('updated_at = ?');
    params.push(updatedAt, id);
    const result = this.db.prepare(`UPDATE library_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return result.changes > 0;
  }

  deleteItem(id: string): boolean {
    const result = this.db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * 学习状态迁移（N-LIBRARY-LEARN-STATUS 状态机唯一写口）。
   * 只动 learn_* 列：学习状态churn不该重排按 updated_at 排序的用户列表。
   */
  updateLearnStatus(
    id: string,
    status: LibraryLearnStatus,
    patch: { error?: string | null; now: number },
  ): boolean {
    const current = this.db
      .prepare('SELECT learn_status FROM library_items WHERE id = ?')
      .get(id) as SQLiteRow | undefined;
    if (!current) return false;
    const currentStatus = isLibraryLearnStatus(String(current.learn_status ?? ''))
      ? current.learn_status as LibraryLearnStatus
      : 'pending';
    const allowed: Record<LibraryLearnStatus, readonly LibraryLearnStatus[]> = {
      pending: ['pending', 'running', 'failed'],
      running: ['running', 'ready', 'failed'],
      ready: ['ready', 'running'],
      failed: ['failed', 'running'],
    };
    if (!allowed[currentStatus].includes(status)) {
      throw new Error(`Invalid library learn status transition: ${currentStatus} -> ${status}`);
    }
    const result = this.db
      .prepare(
        `UPDATE library_items
         SET learn_status = ?, learn_error = ?, learn_updated_at = ?
         WHERE id = ?`,
      )
      .run(status, patch.error ? guardLibraryText(patch.error, 1_000) : null, patch.now, id);
    return result.changes > 0;
  }

  /** 待学习条目 id（迁移旧行 + 卡死的 running），供 sweep 补跑 */
  listPendingLearnIds(limit: number, now: number = Date.now(), staleRunningMs: number = 120_000): string[] {
    const staleBefore = now - staleRunningMs;
    const rows = this.db
      .prepare(
        `SELECT id FROM library_items
         WHERE learn_status = 'pending'
            OR (learn_status = 'running' AND (learn_updated_at IS NULL OR learn_updated_at < ?))
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(staleBefore, limit) as SQLiteRow[];
    return rows.map((row) => row.id as string);
  }

  /** 按路径跨项目找条目（依据投影：citation.source 不携带项目语义） */
  findByPathAnyProject(pathOrUri: string): LibraryItem | undefined {
    const normalizedPathOrUri = normalizePathOrUri(pathOrUri);
    const row = this.db
      .prepare('SELECT * FROM library_items WHERE path_or_uri = ? ORDER BY updated_at DESC LIMIT 1')
      .get(normalizedPathOrUri) as SQLiteRow | undefined;
    return row ? rowToLibraryItem(row) : undefined;
  }

  findByPath(projectId: string | null, pathOrUri: string): LibraryItem | undefined {
    const normalizedPathOrUri = normalizePathOrUri(pathOrUri);
    const row = (projectId === null
      ? this.db.prepare('SELECT * FROM library_items WHERE project_id IS NULL AND path_or_uri = ?').get(normalizedPathOrUri)
      : this.db.prepare('SELECT * FROM library_items WHERE project_id = ? AND path_or_uri = ?').get(projectId, normalizedPathOrUri)
    ) as SQLiteRow | undefined;
    return row ? rowToLibraryItem(row) : undefined;
  }

  findByContentHash(projectId: string | null, contentHash: string): LibraryItem | undefined {
    const row = (projectId === null
      ? this.db.prepare('SELECT * FROM library_items WHERE project_id IS NULL AND content_hash = ?').get(contentHash)
      : this.db.prepare('SELECT * FROM library_items WHERE project_id = ? AND content_hash = ?').get(projectId, contentHash)
    ) as SQLiteRow | undefined;
    return row ? rowToLibraryItem(row) : undefined;
  }

  // --- session_context_pins ---

  getPin(sessionId: string): SessionContextPin | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_context_pins WHERE session_id = ?')
      .get(sessionId) as SQLiteRow | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id as string,
      itemIds: parseJsonArray(row.item_ids),
      addedAt: row.added_at as number,
    };
  }

  setPin(pin: SessionContextPin): void {
    this.db.prepare(`
      INSERT INTO session_context_pins (session_id, item_ids, added_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET item_ids = excluded.item_ids, added_at = excluded.added_at
    `).run(pin.sessionId, JSON.stringify(pin.itemIds), pin.addedAt);
  }

  deletePin(sessionId: string): boolean {
    const result = this.db.prepare('DELETE FROM session_context_pins WHERE session_id = ?').run(sessionId);
    return result.changes > 0;
  }
}
