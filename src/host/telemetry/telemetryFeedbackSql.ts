import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { TelemetryFeedbackRating } from '../../shared/contract/telemetry';

const logger = createLogger('TelemetryFeedbackSql');

/**
 * 读回一个会话内已存的轮次评价（UI 高亮回填用）。
 * 只出锚点与评分——comment/full_content 刻意不带，回填不需要且降低外泄面。
 * 独立于 TelemetryStorage 类（它已顶着 1000 有效行上限），直接拿 DB、DB 不可用回空。
 */
export function getSessionFeedbackRatings(sessionId: string): TelemetryFeedbackRating[] {
  if (!sessionId) return [];
  try {
    const db = getDatabase().getDb();
    if (!db) return [];
    const rows = db
      .prepare('SELECT message_id, rating FROM telemetry_feedback WHERE session_id = ? AND message_id IS NOT NULL')
      .all(sessionId) as Array<{ message_id: string; rating: number }>;
    return rows
      .filter((row) => row.rating === 1 || row.rating === -1)
      .map((row) => ({ messageId: row.message_id, rating: row.rating as 1 | -1 }));
  } catch (error) {
    logger.error('Failed to get session feedback ratings:', error);
    return [];
  }
}
