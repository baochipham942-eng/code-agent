// 账本外模型输入的通用内容寻址缓存。content 存 canonical ModelMessage JSON，
// 让 P1 可按 hash 逐字节取回动态尾巴、运行时注入和拼装后改写产物。
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContentCache');

export class ContentCache {
  private static instance: ContentCache | null = null;

  static getInstance(): ContentCache {
    if (!this.instance) this.instance = new ContentCache();
    return this.instance;
  }

  private getDb() {
    const database = getDatabase();
    if (!database.isReady) return null;
    return database.getDb();
  }

  ensureTable(): void {
    try {
      this.getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS content_cache (
          hash TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (error) {
      logger.error('Failed to create content_cache table:', error);
    }
  }

  store(hash: string, content: string): boolean {
    try {
      const db = this.getDb();
      if (!db) return false;
      db.prepare(`
        INSERT OR IGNORE INTO content_cache (hash, content, created_at)
        VALUES (?, ?, ?)
      `).run(hash, content, Date.now());
      return true;
    } catch (error) {
      logger.debug('Failed to store replay content:', { errorMessage: (error as Error).message });
      return false;
    }
  }

  get(hash: string): string | null {
    try {
      const db = this.getDb();
      if (!db) return null;
      const row = db.prepare('SELECT content FROM content_cache WHERE hash = ?')
        .get(hash) as { content: string } | undefined;
      return row?.content ?? null;
    } catch (error) {
      logger.error('Failed to get replay content:', error);
      return null;
    }
  }
}

export function getContentCache(): ContentCache {
  return ContentCache.getInstance();
}
