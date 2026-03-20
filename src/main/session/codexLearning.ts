// ============================================================================
// Codex Session Learning
//
// Extracts error→recovery patterns from Codex CLI sessions and feeds them
// into code-agent's ErrorLearningService for cross-agent knowledge transfer.
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getErrorLearningService } from '../services/errorLearning';
import { discoverCodexSessions, parseCodexSession } from './codexSessionParser';
import { CODEX_SESSION } from '../../shared/constants';

const logger = createLogger('CodexLearning');

export interface CodexLearningResult {
  sessionsProcessed: number;
  patternsExtracted: number;
  errorsRecorded: number;
  resolutionsRecorded: number;
}

/**
 * Scan recent Codex sessions and extract error→recovery patterns
 * into the ErrorLearningService.
 *
 * Each failed tool call is recorded as an error, and if a subsequent
 * successful call of the same tool type exists (within 3 calls), it's
 * recorded as a resolution.
 */
export async function learnFromCodexSessions(
  lookbackDays = CODEX_SESSION.LEARNING_LOOKBACK_DAYS,
): Promise<CodexLearningResult> {
  const result: CodexLearningResult = {
    sessionsProcessed: 0,
    patternsExtracted: 0,
    errorsRecorded: 0,
    resolutionsRecorded: 0,
  };

  // 1. Discover sessions
  const sessions = await discoverCodexSessions({ lookbackDays });
  if (sessions.length === 0) {
    logger.info('No Codex sessions found in the lookback period');
    return result;
  }

  logger.info(`Found ${sessions.length} Codex sessions to process`);

  const errorService = getErrorLearningService();

  // 2. Parse each session
  for (const meta of sessions) {
    try {
      const parsed = await parseCodexSession(meta.rolloutPath);
      result.sessionsProcessed++;

      // 3. Collect recovery failure IDs to avoid double-recording
      const recoveredFailIds = new Set(
        parsed.recoveries.map(r => r.failedCall.id),
      );

      // 4. Record non-recovered errors only (recovered ones handled in step 5)
      for (const errorOutput of parsed.errors) {
        // Skip errors that have a recovery (will be recorded in step 5)
        // Use output as proxy since errors[] is just string[]
        const isRecovered = parsed.recoveries.some(
          r => r.failedCall.output === errorOutput,
        );
        if (isRecovered) continue;

        const truncated = errorOutput.length > 2000
          ? errorOutput.slice(0, 2000) + '... (truncated)'
          : errorOutput;

        errorService.recordError(truncated, {
          model: parsed.metadata.model,
          cwd: parsed.metadata.cwd,
          source: 'codex',
        }, 'codex-bash');
        result.errorsRecorded++;
      }

      // 5. Record recoveries (error + resolution together)
      for (const recovery of parsed.recoveries) {
        result.patternsExtracted++;

        // Record the failed call as error
        const pattern = errorService.recordError(
          recovery.failedCall.output.slice(0, 2000),
          {
            command: recovery.failedCall.input,
            model: parsed.metadata.model,
            source: 'codex',
          },
          'codex-bash',
        );

        // Record the recovery action
        if (pattern) {
          errorService.recordResolution(
            pattern.signature,
            recovery.recoveryCall.input,
            true,
          );
          result.resolutionsRecorded++;
        }
      }
    } catch (err) {
      logger.warn(`Failed to parse session ${meta.rolloutPath}: ${err}`);
    }
  }

  logger.info(
    `Codex learning complete: ${result.sessionsProcessed} sessions, ` +
    `${result.errorsRecorded} errors, ${result.resolutionsRecorded} resolutions`,
  );

  return result;
}
