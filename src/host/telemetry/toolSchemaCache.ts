// ============================================================================
// Tool Schema Cache - 最终模型工具表的内容寻址缓存
// ============================================================================
// DDL 已收进中央 schema（schemaTelemetry.ts，启动期 retention 依赖）；
// 此处的 ensureTable 仅作 dbOverride/测试兜底，改列必须两处同步。

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ToolSchemaCache');

export class ToolSchemaCache {
  private static instance: ToolSchemaCache | null = null;

  static getInstance(): ToolSchemaCache {
    if (!this.instance) this.instance = new ToolSchemaCache();
    return this.instance;
  }

  private getDb() {
    const dbService = getDatabase();
    if (!dbService.isReady) return null;
    return dbService.getDb();
  }

  ensureTable(): void {
    try {
      this.getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS tool_schema_cache (
          hash TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (error) {
      logger.error('Failed to create tool_schema_cache table:', error);
    }
  }

  store(hash: string, content: string): void {
    try {
      const db = this.getDb();
      if (!db) return;
      db.prepare(`
        INSERT OR IGNORE INTO tool_schema_cache (hash, content, created_at)
        VALUES (?, ?, ?)
      `).run(hash, content, Date.now());
    } catch (error) {
      logger.debug('Failed to store tool schema:', { errorMessage: (error as Error).message });
    }
  }

  get(hash: string): string | null {
    try {
      const db = this.getDb();
      if (!db) return null;
      const row = db.prepare('SELECT content FROM tool_schema_cache WHERE hash = ?')
        .get(hash) as { content: string } | undefined;
      return row?.content ?? null;
    } catch (error) {
      logger.error('Failed to get tool schema:', error);
      return null;
    }
  }
}

export function getToolSchemaCache(): ToolSchemaCache {
  return ToolSchemaCache.getInstance();
}
