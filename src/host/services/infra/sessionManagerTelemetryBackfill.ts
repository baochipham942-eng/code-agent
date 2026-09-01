import type { Message } from '../../../shared/contract';
import { getDatabase } from '../core';
import { createLogger } from './logger';
import {
  findMissingTelemetryPromptRows,
  formatTelemetryRecoveredPrompt,
} from './sessionManagerNormalization';

interface TelemetryUserPromptRow {
  id: string;
  user_prompt: string;
  start_time: number | string;
}

interface ExistingUserMessageRow {
  content: string;
  timestamp?: number | string;
}

const logger = createLogger('SessionManager');

export function backfillMissingTelemetryUserPrompts(
  sessionId: string,
  authoritativeMessages?: readonly Message[],
): number {
  const db = getDatabase();
  const rawDb = db.getDb();
  if (!rawDb) return 0;

  try {
    const telemetryRows = rawDb.prepare(`
      SELECT id, user_prompt, start_time
      FROM telemetry_turns
      WHERE session_id = ?
        AND COALESCE(turn_type, 'user') = 'user'
        AND user_prompt IS NOT NULL
        AND TRIM(user_prompt) != ''
      ORDER BY start_time ASC, turn_number ASC, id ASC
    `).all(sessionId) as TelemetryUserPromptRow[];
    if (telemetryRows.length === 0) return 0;

    const existingRows: ExistingUserMessageRow[] = authoritativeMessages
      ? authoritativeMessages
          .filter((message) => message.role === 'user')
          .map((message) => ({ content: message.content, timestamp: message.timestamp }))
      : rawDb.prepare(`
          SELECT content, timestamp
          FROM messages
          WHERE session_id = ? AND role = 'user'
        `).all(sessionId) as ExistingUserMessageRow[];
    const missingTelemetryRows = findMissingTelemetryPromptRows(telemetryRows, existingRows);

    for (const row of missingTelemetryRows) {
      const timestamp = Number(row.start_time);
      db.addMessage(
        sessionId,
        {
          id: `telemetry-user-${row.id}`,
          role: 'user',
          content: formatTelemetryRecoveredPrompt(row.user_prompt),
          timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        },
        { skipTimestampUpdate: true },
      );
    }

    if (missingTelemetryRows.length > 0) {
      db.reconcileMessageProjectionOrder(
        sessionId,
        'SessionManager telemetry backfill chronological reconciliation',
      );
      logger.info('Backfilled missing user prompts from telemetry', {
        sessionId,
        inserted: missingTelemetryRows.length,
      });
    }
    return missingTelemetryRows.length;
  } catch (error) {
    logger.warn('Failed to backfill user prompts from telemetry', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
