// ============================================================================
// Experiment Adapter - TestRunner → 统一评测数据模型
// ============================================================================

import { execSync } from 'child_process';
import type { DatabaseService } from '../services/core/databaseService';
import type { TestRunSummary, TestResult } from '../testing/types';

/**
 * 将 TestRunner 的 TestRunSummary 转换为统一 experiment 格式并持久化到数据库
 */
export class ExperimentAdapter {
  constructor(private db: DatabaseService) {}

  /**
   * Get the current git commit hash, or 'unknown' if unavailable.
   */
  private getGitCommit(): string {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Convert TestRunSummary to experiment records and persist to DB
   * @returns experimentId
   */
  async persistTestRun(summary: TestRunSummary): Promise<string> {
    const experimentId = summary.runId || crypto.randomUUID();

    const experiment = {
      id: experimentId,
      name: `eval-${new Date(summary.startTime).toISOString().slice(0, 10)}`,
      timestamp: summary.startTime,
      model: summary.environment?.model || 'unknown',
      provider: summary.environment?.provider || 'unknown',
      scope: 'full',
      config_json: JSON.stringify({
        generation: summary.environment?.generation,
        workingDirectory: summary.environment?.workingDirectory,
      }),
      summary_json: JSON.stringify({
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        partial: summary.partial || 0,
        skipped: summary.skipped || 0,
        passRate: summary.total > 0 ? summary.passed / summary.total : 0,
        avgScore: summary.averageScore || 0,
        duration: summary.duration || 0,
        performance: summary.performance,
        ...(summary.results?.some(r => r.trials) ? {
          trialsPerCase: summary.results.find(r => r.trials)?.trials?.length || 1,
          flakyCount: summary.results.filter(r => r.trials && r.trials.some(t => t.status === 'passed') && r.trials.some(t => t.status !== 'passed')).length,
        } : {}),
      }),
      source: 'test-runner',
      git_commit: this.getGitCommit(),
    };

    const cases = (summary.results || []).map((r: TestResult) => ({
      id: crypto.randomUUID(),
      case_id: r.testId,
      session_id: r.sessionId,
      status: r.status,
      score: Math.round((r.score ?? (r.status === 'passed' ? 1 : 0)) * 100),
      duration_ms: r.duration || 0,
      data_json: JSON.stringify({
        description: r.description,
        errors: r.errors,
        failureReason: r.failureReason,
        failureStage: r.failureStage,
        failureDetails: r.failureDetails,
        turnCount: r.turnCount,
        toolExecutions: r.toolExecutions?.length || 0,
        expectationResults: r.expectationResults,
        ...(r.trials ? { trials: r.trials } : {}),
      }),
    }));

    this.db.insertExperiment(experiment);
    this.db.insertExperimentCases(experimentId, cases);

    return experimentId;
  }
}
