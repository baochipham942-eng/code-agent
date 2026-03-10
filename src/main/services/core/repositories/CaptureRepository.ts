// ============================================================================
// CaptureRepository - 知识库采集内容持久化（captures 表）
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { CaptureItem, CaptureSource, CaptureStats } from '../../../../shared/types/capture';

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

export class CaptureRepository {
  constructor(private db: BetterSqlite3.Database) {}

  createCapture(item: CaptureItem): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO captures (id, url, title, content, summary, source, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.url || null,
      item.title,
      item.content,
      item.summary || null,
      item.source,
      JSON.stringify(item.tags),
      JSON.stringify(item.metadata),
      item.createdAt,
      item.updatedAt,
    );
  }

  listCaptures(opts?: { source?: CaptureSource; limit?: number; offset?: number }): CaptureItem[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.source) {
      conditions.push('source = ?');
      params.push(opts.source);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit || 50;
    const offset = opts?.offset || 0;

    const rows = this.db.prepare(`
      SELECT * FROM captures ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SQLiteRow[];

    return rows.map(row => this.rowToCaptureItem(row));
  }

  getCapture(id: string): CaptureItem | undefined {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as SQLiteRow | undefined;
    return row ? this.rowToCaptureItem(row) : undefined;
  }

  deleteCapture(id: string): boolean {
    const result = this.db.prepare('DELETE FROM captures WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getCaptureStats(): CaptureStats {
    const totalRow = this.db.prepare('SELECT COUNT(*) as c FROM captures').get() as SQLiteRow;
    const total = totalRow.c as number;

    const bySource: Record<CaptureSource, number> = {
      browser_extension: 0,
      manual: 0,
      wechat: 0,
      local_file: 0,
    };
    const sourceRows = this.db.prepare('SELECT source, COUNT(*) as c FROM captures GROUP BY source').all() as SQLiteRow[];
    for (const row of sourceRows) {
      bySource[row.source as CaptureSource] = row.c as number;
    }

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentRow = this.db.prepare('SELECT COUNT(*) as c FROM captures WHERE created_at > ?').get(weekAgo) as SQLiteRow;

    return {
      total,
      bySource,
      recentlyAdded: recentRow.c as number,
    };
  }

  searchCaptures(query: string, limit: number = 20): CaptureItem[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM captures
      WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(pattern, pattern, pattern, limit) as SQLiteRow[];

    return rows.map(row => this.rowToCaptureItem(row));
  }

  private rowToCaptureItem(row: SQLiteRow): CaptureItem {
    return {
      id: row.id as string,
      url: (row.url as string) || undefined,
      title: row.title as string,
      content: row.content as string,
      summary: (row.summary as string) || undefined,
      source: row.source as CaptureSource,
      tags: JSON.parse((row.tags as string) || '[]'),
      metadata: JSON.parse((row.metadata as string) || '{}'),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
