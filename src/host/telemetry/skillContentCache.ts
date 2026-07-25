// ============================================================================
// Skill Content Cache — skill 内容按 hash 入账（2026-07-25 费曼审计 P2-1）
// ============================================================================
// 病根：账本此前只有 skill 名字，而 user/project skill 鼓励模型自改 SKILL.md
// 且 skillWatcher 自动重载——同名不同内容在账本里无法区分，历史会话不可复现。
// 修法与 prompt 侧同构（system_prompt_hash + system_prompt_cache 全文表）：
// skill 每次被调用时算内容 hash，hash 随调用消息进入会话/账本，
// 全文按 hash 去重存本表，评测中心可按 hash 还原当时的 SKILL.md。
// ============================================================================

import { createHash } from 'crypto';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { guardSensitiveText } from '../security/sensitiveDataGuard';

const logger = createLogger('SkillContentCache');

/** skill 内容 hash（16 hex，与调用消息里的 <command-content-hash> 一致） */
export function hashSkillContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export class SkillContentCache {
  private static instance: SkillContentCache | null = null;

  static getInstance(): SkillContentCache {
    if (!this.instance) {
      this.instance = new SkillContentCache();
    }
    return this.instance;
  }

  private getDb() {
    const dbService = getDatabase();
    if (!dbService.isReady) return null;
    return dbService.getDb();
  }

  ensureTable(): void {
    try {
      const db = this.getDb();
      if (!db) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_content_cache (
          hash TEXT PRIMARY KEY,
          skill_name TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (error) {
      logger.error('Failed to create skill_content_cache table:', error);
    }
  }

  /** 存储 skill 全文（相同 hash 不重复写；DB 未就绪时静默跳过，不阻塞 skill 调用） */
  store(hash: string, skillName: string, content: string): void {
    try {
      const db = this.getDb();
      if (!db) return;
      this.ensureTable();
      const safeContent = guardSensitiveText(content, {
        surface: 'prompt',
        mode: 'diagnostic',
        maxLength: 100_000,
      });
      db.prepare(`
        INSERT OR IGNORE INTO skill_content_cache (hash, skill_name, content, created_at)
        VALUES (?, ?, ?, ?)
      `).run(hash, skillName, safeContent, Date.now());
    } catch (error) {
      logger.debug('Failed to store skill content:', { errorMessage: (error as Error).message });
    }
  }

  get(hash: string): { skillName: string; content: string } | null {
    try {
      const db = this.getDb();
      if (!db) return null;
      const row = db.prepare(`
        SELECT skill_name, content FROM skill_content_cache WHERE hash = ?
      `).get(hash) as { skill_name: string; content: string } | undefined;
      if (!row) return null;
      return { skillName: row.skill_name, content: row.content };
    } catch (error) {
      logger.error('Failed to get skill content:', error);
      return null;
    }
  }
}

export function getSkillContentCache(): SkillContentCache {
  return SkillContentCache.getInstance();
}
