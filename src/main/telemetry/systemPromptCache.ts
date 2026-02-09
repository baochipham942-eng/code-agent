// ============================================================================
// System Prompt Cache - 系统提示词缓存
// ============================================================================
// 存储系统提示词全文，通过 SHA-256 hash 索引
// 用于评测中心查看历史会话的系统提示词
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SystemPromptCache');

export class SystemPromptCache {
  private static instance: SystemPromptCache | null = null;

  static getInstance(): SystemPromptCache {
    if (!this.instance) {
      this.instance = new SystemPromptCache();
    }
    return this.instance;
  }

  private getDb() {
    const db = getDatabase().getDb();
    if (!db) throw new Error('Database not initialized');
    return db;
  }

  /**
   * 确保表存在
   */
  ensureTable(): void {
    try {
      this.getDb().exec(`
        CREATE TABLE IF NOT EXISTS system_prompt_cache (
          hash TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tokens INTEGER,
          generation_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (error) {
      logger.error('Failed to create system_prompt_cache table:', error);
    }
  }

  /**
   * 存储系统提示词（去重：相同 hash 不重复写入）
   */
  store(hash: string, content: string, tokens?: number, generationId?: string): void {
    try {
      this.getDb().prepare(`
        INSERT OR IGNORE INTO system_prompt_cache (hash, content, tokens, generation_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(hash, content, tokens ?? null, generationId ?? null, Date.now());
    } catch (error) {
      logger.debug('Failed to store system prompt:', { errorMessage: (error as Error).message });
    }
  }

  /**
   * 按 hash 获取系统提示词
   */
  get(hash: string): { content: string; tokens: number | null; generationId: string | null } | null {
    try {
      const row = this.getDb().prepare(`
        SELECT content, tokens, generation_id FROM system_prompt_cache WHERE hash = ?
      `).get(hash) as { content: string; tokens: number | null; generation_id: string | null } | undefined;

      if (!row) return null;
      return {
        content: row.content,
        tokens: row.tokens,
        generationId: row.generation_id,
      };
    } catch (error) {
      logger.error('Failed to get system prompt:', error);
      return null;
    }
  }
}

// Singleton accessor
export function getSystemPromptCache(): SystemPromptCache {
  return SystemPromptCache.getInstance();
}
