// ============================================================================
// Profile Store - Agent 性能画像持久化
// ============================================================================
// 使用 SQLite（复用现有 databaseService）持久化 Agent 性能数据。
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { AgentProfile } from './agentProfiler';

const logger = createLogger('ProfileStore');

// ============================================================================
// Schema
// ============================================================================

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    total_executions INTEGER DEFAULT 0,
    avg_score REAL DEFAULT 0,
    avg_duration_ms REAL DEFAULT 0,
    avg_cost_usd REAL DEFAULT 0,
    wilson_score REAL DEFAULT 0,
    last_updated INTEGER NOT NULL,
    PRIMARY KEY (agent_id, task_type)
  )
`;

// ============================================================================
// Profile Store
// ============================================================================

export class ProfileStore {
  private db: any = null; // better-sqlite3 Database instance

  /**
   * Initialize with a database instance (from databaseService)
   */
  async initialize(database: any): Promise<void> {
    this.db = database;
    try {
      this.db.exec(CREATE_TABLE_SQL);
      logger.info('Profile store initialized');
    } catch (error) {
      logger.error('Failed to initialize profile store:', error);
    }
  }

  /**
   * Save profiles to database
   */
  saveProfiles(profiles: AgentProfile[]): void {
    if (!this.db) {
      logger.warn('Database not initialized, skipping save');
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_profiles
        (agent_id, task_type, agent_name, success_count, failure_count,
         total_executions, avg_score, avg_duration_ms, avg_cost_usd,
         wilson_score, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const p of profiles) {
        stmt.run(
          p.agentId, p.taskType, p.agentName,
          p.successCount, p.failureCount, p.totalExecutions,
          p.avgScore, p.avgDurationMs, p.avgCostUSD,
          p.wilsonScore, p.lastUpdated
        );
      }
    });

    try {
      transaction();
      logger.debug(`Saved ${profiles.length} profiles to database`);
    } catch (error) {
      logger.error('Failed to save profiles:', error);
    }
  }

  /**
   * Load profiles from database
   */
  loadProfiles(): AgentProfile[] {
    if (!this.db) {
      logger.warn('Database not initialized, returning empty');
      return [];
    }

    try {
      const rows = this.db.prepare('SELECT * FROM agent_profiles').all() as any[];
      return rows.map(row => ({
        agentId: row.agent_id,
        agentName: row.agent_name,
        taskType: row.task_type,
        successCount: row.success_count,
        failureCount: row.failure_count,
        totalExecutions: row.total_executions,
        avgScore: row.avg_score,
        avgDurationMs: row.avg_duration_ms,
        avgCostUSD: row.avg_cost_usd,
        wilsonScore: row.wilson_score,
        lastUpdated: row.last_updated,
      }));
    } catch (error) {
      logger.error('Failed to load profiles:', error);
      return [];
    }
  }

  /**
   * Check if store is initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: ProfileStore | null = null;

export function getProfileStore(): ProfileStore {
  if (!instance) {
    instance = new ProfileStore();
  }
  return instance;
}
