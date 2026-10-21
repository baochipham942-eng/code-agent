// ============================================================================
// testRunnerReporting - 测试运行的性能统计与结果落盘（自 testRunner.ts 拆出，正文 verbatim）
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { TestResult, TestRunSummary, TestRunnerConfig } from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TestRunner');

/**
 * Calculate performance statistics
 */
export function calculatePerformanceStats(
  results: TestResult[]
): TestRunSummary['performance'] {
  const durations = results
    .filter(
      (result) =>
        result.status !== 'skipped'
        && result.status !== 'infra_excluded'
        && result.status !== 'cost_exceeded'
        && result.status !== 'not_run',
    )
    .map((r) => r.duration);

  return {
    avgResponseTime: durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0,
    maxResponseTime: durations.length > 0 ? Math.max(...durations) : 0,
    totalToolCalls: results.reduce((sum, r) => sum + r.toolExecutions.length, 0),
    totalTurns: results.reduce((sum, r) => sum + r.turnCount, 0),
  };
}

/**
 * Save results to file
 */
export async function saveResults(config: TestRunnerConfig, summary: TestRunSummary): Promise<void> {
  const resultsDir = config.resultsDir;
  await fs.mkdir(resultsDir, { recursive: true });

  // Save JSON results
  const jsonPath = path.join(
    resultsDir,
    `test-results-${new Date().toISOString().slice(0, 10)}.json`
  );
  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

  logger.info('Results saved', { path: jsonPath });

  if (config.persistExperiment === false) return;

  // Persist to unified experiment DB (best-effort)
  try {
    const { ExperimentAdapter } = await import('../../../packages/internal/evaluation-center/src/host/evaluation/experimentAdapter');
    const { getDatabase } = await import('../services/core/databaseService');
    const db = getDatabase();
    const adapter = new ExperimentAdapter(db);
    await adapter.persistTestRun(summary);
    logger.info('Test run persisted to experiment DB');
  } catch (err) {
    // DB persistence is best-effort, don't fail the test run
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to persist test run to DB', { error: msg });
    summary.persistenceWarning = `DB persistence failed: ${msg}`;
  }
}
