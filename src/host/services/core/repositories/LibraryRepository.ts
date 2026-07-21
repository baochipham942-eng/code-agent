// ============================================================================
// LibraryRepository - 项目资料库条目 + 会话上下文 pin 持久化
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { LibraryItem, LibraryItemKind, LibraryListOptions, SessionContextPin } from '@shared/contract/library';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';

type SQLiteRow = Record<string, unknown>;

function guardLibraryText(value: string, maxLength: number): string {
  return guardSensitiveText(value, {
    surface: 'knowledge',
    mode: 'local-persist',
    maxLength,
  }).trim();
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
        (id, project_id, title, kind, path_or_uri, tags, summary, source_session_id, source_role_id, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.projectId,
      guardLibraryText(item.title, 2_000),
      item.kind,
      guardLibraryText(item.pathOrUri, 4_000),
      JSON.stringify(item.tags.map((tag) => guardLibraryText(tag, 500))),
      item.summary ? guardLibraryText(item.summary, 2_000) : null,
      item.sourceSessionId ?? null,
      item.sourceRoleId ?? null,
      item.contentHash ?? null,
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
