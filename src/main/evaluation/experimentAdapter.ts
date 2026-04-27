// ============================================================================
// Experiment Adapter - runner outputs -> canonical eval run -> experiment DB
// ============================================================================

import { execSync } from 'child_process';
import type { DatabaseService } from '../services/core/databaseService';
import type { TestRunSummary, TestResult } from '../testing/types';
import { getReplayCompletenessReasons } from '../../shared/contract/evaluation';
import type {
  CanonicalEvalCase,
  CanonicalEvalRun,
  CanonicalEvalRunTotals,
  CanonicalEvalTrial,
  EvalCaseStatus,
  EvalRunAggregation,
  TelemetryCompleteness,
} from '../../shared/contract/evaluation';
import { buildSessionTraceIdentity } from '../../shared/contract/reviewQueue';

type ExperimentDbWriter = Pick<DatabaseService, 'insertExperiment' | 'insertExperimentCases'>;

export interface EvalHarnessExperimentResultLike {
  experimentId: string;
  cases: Array<{
    caseId: string;
    trials: Array<{
      trialIndex: number;
      score: number;
      passed: boolean;
      error?: string;
      durationMs: number;
      sessionId?: string;
      replayKey?: string;
      telemetryCompleteness?: TelemetryCompleteness;
      replayExplanation?: string;
      degraded?: boolean;
      gateFailures?: string[];
      forbiddenResult?: unknown;
      swissCheeseResult?: unknown;
    }>;
    medianScore: number;
    passed: boolean;
    failureReason?: string;
  }>;
  overallPassRate: number;
  timestamp: string;
}

export interface RegressionReportLike {
  runId: string;
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  durationMs: number;
  results: Array<{
    id: string;
    status: 'pass' | 'fail' | 'error';
    durationMs: number;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    errorMessage?: string;
  }>;
}

export class ExperimentAdapter {
  constructor(private db: ExperimentDbWriter) {}

  private getGitCommit(): string {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      return 'unknown';
    }
  }

  private normalizeScore(score: number, scale: 'zero_one' | 'zero_hundred'): number {
    const normalized = scale === 'zero_one' ? score * 100 : score;
    return Math.max(0, Math.min(100, normalized));
  }

  private normalizeTestStatus(status: TestResult['status']): EvalCaseStatus {
    if (status === 'passed' || status === 'failed' || status === 'partial' || status === 'skipped') {
      return status;
    }
    return 'error';
  }

  private computeTotals(cases: CanonicalEvalCase[]): CanonicalEvalRunTotals {
    const total = cases.length;
    const passed = cases.filter(c => c.status === 'passed').length;
    const failed = cases.filter(c => c.status === 'failed').length;
    const partial = cases.filter(c => c.status === 'partial').length;
    const skipped = cases.filter(c => c.status === 'skipped').length;
    const errored = cases.filter(c => c.status === 'error').length;
    const scored = cases.filter(c => c.status !== 'skipped');
    const averageScore = scored.length > 0
      ? scored.reduce((sum, c) => sum + c.score, 0) / scored.length
      : 0;

    return {
      total,
      passed,
      failed,
      partial,
      skipped,
      errored,
      passRate: total > 0 ? passed / total : 0,
      averageScore,
    };
  }

  private buildSummaryJson(run: CanonicalEvalRun): string {
    return JSON.stringify({
      total: run.totals.total,
      passed: run.totals.passed,
      failed: run.totals.failed,
      partial: run.totals.partial,
      skipped: run.totals.skipped,
      errored: run.totals.errored,
      passRate: run.totals.passRate,
      // Legacy Eval Center UI expects avgScore in 0-1.
      avgScore: run.totals.averageScore / 100,
      duration: run.durationMs || 0,
      aggregation: run.aggregation,
      source: run.source,
      canonical: {
        schemaVersion: run.schemaVersion,
        averageScore100: run.totals.averageScore,
        caseCount: run.cases.length,
      },
      ...(run.metadata || {}),
    });
  }

  private buildCaseDataJson(run: CanonicalEvalRun, c: CanonicalEvalCase): string {
    return JSON.stringify({
      ...(c.metadata || {}),
      sessionId: c.sessionId,
      replayKey: c.replayKey,
      telemetryCompleteness: c.telemetryCompleteness,
      failureReason: c.failureReason,
      failureStage: c.failureStage,
      aggregation: run.aggregation,
      source: run.source,
      score100: c.score,
      ...(c.trials ? { trials: c.trials } : {}),
    });
  }

  private buildRealAgentRunGate(result: TestResult): {
    passed: boolean;
    reasons: string[];
  } {
    if (result.telemetryGate) {
      return {
        passed: result.telemetryGate.passed,
        reasons: result.telemetryGate.failures,
      };
    }

    const completeness = result.telemetryCompleteness;
    if (!completeness) {
      return {
        passed: false,
        reasons: ['missing_telemetry_completeness'],
      };
    }

    const reasons = [
      ...(completeness.incompleteReasons || getReplayCompletenessReasons({
        sessionId: completeness.sessionId ?? result.sessionId,
        replayKey: completeness.replayKey ?? result.replayKey,
        dataSource: completeness.dataSource,
        turnCount: completeness.turnCount,
        modelCallCount: completeness.modelCallCount,
        toolCallCount: completeness.toolCallCount,
        eventCount: completeness.eventCount,
        hasModelDecisions: completeness.hasModelDecisions,
        hasToolSchemas: completeness.hasToolSchemas,
      })),
      ...(completeness.hasRealAgentTrace === true ? [] : ['missing_real_agent_trace']),
    ];

    return {
      passed: reasons.length === 0,
      reasons: Array.from(new Set(reasons)),
    };
  }

  private buildTestResultTelemetryCompleteness(result: TestResult): TelemetryCompleteness {
    if (result.telemetryCompleteness) {
      const base = {
        ...result.telemetryCompleteness,
        sessionId: result.telemetryCompleteness.sessionId || result.sessionId,
        replayKey: result.telemetryCompleteness.replayKey || result.replayKey,
      };
      const incompleteReasons = base.incompleteReasons || getReplayCompletenessReasons({
        sessionId: base.sessionId,
        replayKey: base.replayKey,
        dataSource: base.dataSource,
        turnCount: base.turnCount,
        modelCallCount: base.modelCallCount,
        toolCallCount: base.toolCallCount,
        eventCount: base.eventCount,
        hasModelDecisions: base.hasModelDecisions,
        hasToolSchemas: base.hasToolSchemas,
      });
      return {
        ...base,
        hasRealAgentTrace: base.hasRealAgentTrace ?? incompleteReasons.length === 0,
        incompleteReasons,
      };
    }
    const trace = result.sessionId ? buildSessionTraceIdentity(result.sessionId) : undefined;
    const base = {
      sessionId: result.sessionId,
      replayKey: trace?.replayKey,
      turnCount: result.turnCount || 0,
      modelCallCount: 0,
      toolCallCount: result.toolExecutions?.length || 0,
      eventCount: 0,
      hasSessionId: Boolean(result.sessionId),
      hasModelDecisions: false,
      hasToolSchemas: false,
      hasPermissionTrace: false,
      hasContextCompressionEvents: false,
      hasSubagentTelemetry: false,
      source: 'test-runner-summary',
    } satisfies Omit<TelemetryCompleteness, 'hasRealAgentTrace' | 'incompleteReasons'>;
    return {
      ...base,
      hasRealAgentTrace: false,
      incompleteReasons: Array.from(new Set([
        'missing_telemetry_completeness',
        ...getReplayCompletenessReasons(base),
      ])),
    };
  }

  private persistCanonicalRun(run: CanonicalEvalRun): string {
    const experimentId = run.runId || crypto.randomUUID();
    const gitCommit = run.gitCommit || this.getGitCommit();
    const day = new Date(run.startTime).toISOString().slice(0, 10);

    this.db.insertExperiment({
      id: experimentId,
      name: run.name || `${run.source}-${day}`,
      timestamp: run.startTime,
      model: run.environment?.model || 'unknown',
      provider: run.environment?.provider || 'unknown',
      scope: run.scope || 'full',
      config_json: JSON.stringify({
        ...(run.config || {}),
        canonicalSchemaVersion: run.schemaVersion,
        source: run.source,
        aggregation: run.aggregation,
        environment: run.environment,
      }),
      summary_json: this.buildSummaryJson(run),
      source: run.source,
      git_commit: gitCommit,
    });

    this.db.insertExperimentCases(experimentId, run.cases.map(c => ({
      id: c.id || crypto.randomUUID(),
      case_id: c.caseId,
      session_id: c.sessionId,
      status: c.status,
      score: Math.round(c.score),
      duration_ms: c.durationMs || 0,
      data_json: this.buildCaseDataJson(run, c),
    })));

    return experimentId;
  }

  toCanonicalTestRun(summary: TestRunSummary): CanonicalEvalRun {
    const aggregation: EvalRunAggregation = (summary.results || []).some(r => r.trials)
      ? 'best_score_pass_at_k'
      : 'single';

    const cases: CanonicalEvalCase[] = (summary.results || []).map((r: TestResult) => {
      const trace = r.sessionId ? buildSessionTraceIdentity(r.sessionId) : undefined;
      const realAgentRun = this.buildRealAgentRunGate(r);
      const telemetryCompleteness = this.buildTestResultTelemetryCompleteness(r);
      return {
        caseId: r.testId,
        sessionId: r.sessionId,
        replayKey: r.replayKey || trace?.replayKey,
        telemetryCompleteness,
        status: this.normalizeTestStatus(r.status),
        score: this.normalizeScore(r.score ?? (r.status === 'passed' ? 1 : 0), 'zero_one'),
        durationMs: r.duration || 0,
        failureReason: r.failureReason,
        failureStage: r.failureStage,
        trials: r.trials?.map((trial, index): CanonicalEvalTrial => ({
          trialIndex: index,
          status: this.normalizeTestStatus(trial.status),
          score: this.normalizeScore(trial.score, 'zero_one'),
          durationMs: trial.duration_ms || 0,
        })),
        metadata: {
          description: r.description,
          errors: r.errors,
          failureDetails: r.failureDetails,
          turnCount: r.turnCount,
          toolExecutions: r.toolExecutions?.length || 0,
          expectationResults: r.expectationResults,
          telemetryGate: r.telemetryGate,
          realAgentRun,
          ...(r.variance !== undefined ? { variance: r.variance, stdDev: r.stdDev, unstable: r.unstable } : {}),
        },
      };
    });

    return {
      schemaVersion: 1,
      runId: summary.runId || crypto.randomUUID(),
      source: 'test-runner',
      aggregation,
      startTime: summary.startTime,
      endTime: summary.endTime,
      durationMs: summary.duration || 0,
      name: `eval-${new Date(summary.startTime).toISOString().slice(0, 10)}`,
      scope: 'full',
      environment: summary.environment,
      totals: this.computeTotals(cases),
      cases,
      gitCommit: summary.gitCommit,
      config: {
        generation: summary.environment?.generation,
        workingDirectory: summary.environment?.workingDirectory,
      },
      metadata: {
        performance: summary.performance,
        realAgentRun: {
          passed: cases.filter(c => c.metadata?.realAgentRun && (c.metadata.realAgentRun as { passed?: boolean }).passed).length,
          total: cases.length,
        },
        ...(summary.results?.some(r => r.trials) ? {
          trialsPerCase: summary.results.find(r => r.trials)?.trials?.length || 1,
          flakyCount: summary.results.filter(r => r.trials && r.trials.some(t => t.status === 'passed') && r.trials.some(t => t.status !== 'passed')).length,
        } : {}),
        ...(summary.unstableCaseCount !== undefined ? {
          unstableCaseCount: summary.unstableCaseCount,
          averageStdDev: summary.averageStdDev,
        } : {}),
      },
    };
  }

  toCanonicalEvalHarnessResult(
    result: EvalHarnessExperimentResultLike,
    environment?: CanonicalEvalRun['environment']
  ): CanonicalEvalRun {
    const cases: CanonicalEvalCase[] = result.cases.map((c) => {
      const traceTrial = c.trials.find(trial => trial.sessionId || trial.replayKey || trial.telemetryCompleteness);
      const gateFailures = Array.from(new Set(c.trials.flatMap(trial => trial.gateFailures || [])));
      const gateDegraded = c.trials.some(trial => trial.degraded || (trial.gateFailures?.length || 0) > 0);
      const status: EvalCaseStatus = gateDegraded ? 'failed' : c.passed ? 'passed' : 'failed';
      const score = gateDegraded ? 0 : this.normalizeScore(c.medianScore, 'zero_hundred');
      const failureReason = gateDegraded
        ? `real-agent-run gate failed: ${gateFailures.length > 0 ? gateFailures.join(', ') : 'degraded telemetry replay'}`
        : c.failureReason;
      return {
        caseId: c.caseId,
        sessionId: traceTrial?.sessionId,
        replayKey: traceTrial?.replayKey,
        telemetryCompleteness: traceTrial?.telemetryCompleteness,
        status,
        score,
        durationMs: c.trials.reduce((sum, trial) => sum + (trial.durationMs || 0), 0),
        failureReason,
        failureStage: gateDegraded ? 'telemetry_replay_gate' : undefined,
        trials: c.trials.map((trial): CanonicalEvalTrial => ({
          trialIndex: trial.trialIndex,
          status: trial.passed ? 'passed' : 'failed',
          score: this.normalizeScore(trial.score, 'zero_hundred'),
          durationMs: trial.durationMs || 0,
          error: trial.error,
          metadata: {
            sessionId: trial.sessionId,
            replayKey: trial.replayKey,
            telemetryCompleteness: trial.telemetryCompleteness,
            replayExplanation: trial.replayExplanation,
            degraded: trial.degraded,
            gateFailures: trial.gateFailures,
            forbiddenResult: trial.forbiddenResult,
            swissCheeseResult: trial.swissCheeseResult,
          },
        })),
        metadata: {
          medianScore: c.medianScore,
          realAgentRun: traceTrial
            ? {
                sessionId: traceTrial.sessionId,
                replayKey: traceTrial.replayKey,
                telemetryCompleteness: traceTrial.telemetryCompleteness,
                passed: !gateDegraded,
                degraded: gateDegraded,
                gateFailures,
                failureReasons: gateFailures,
              }
            : undefined,
        },
      };
    });

    const startTime = Date.parse(result.timestamp) || Date.now();
    const totals = this.computeTotals(cases);
    const hasGateDegradedCase = cases.some(c => c.failureStage === 'telemetry_replay_gate');
    return {
      schemaVersion: 1,
      runId: result.experimentId || crypto.randomUUID(),
      source: 'eval-harness',
      aggregation: 'median_threshold',
      startTime,
      durationMs: cases.reduce((sum, c) => sum + c.durationMs, 0),
      name: `eval-harness-${new Date(startTime).toISOString().slice(0, 10)}`,
      scope: 'full',
      environment,
      totals: {
        ...totals,
        passRate: hasGateDegradedCase ? totals.passRate : result.overallPassRate,
      },
      cases,
    };
  }

  toCanonicalRegressionReport(report: RegressionReportLike): CanonicalEvalRun {
    const cases: CanonicalEvalCase[] = report.results.map(r => ({
      caseId: r.id,
      status: r.status === 'pass' ? 'passed' : r.status === 'fail' ? 'failed' : 'error',
      score: r.status === 'pass' ? 100 : 0,
      durationMs: r.durationMs || 0,
      failureReason: r.errorMessage,
      metadata: {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
      },
    }));

    return {
      schemaVersion: 1,
      runId: report.runId || crypto.randomUUID(),
      source: 'regression',
      aggregation: 'regression_gate',
      startTime: Date.parse(report.timestamp) || Date.now(),
      durationMs: report.durationMs || 0,
      name: `regression-${new Date(Date.parse(report.timestamp) || Date.now()).toISOString().slice(0, 10)}`,
      scope: 'regression',
      totals: {
        ...this.computeTotals(cases),
        total: report.totalCases,
        passed: report.passed,
        failed: report.failed,
        errored: report.errored,
        passRate: report.passRate,
      },
      cases,
    };
  }

  persistRun(run: CanonicalEvalRun): string {
    return this.persistCanonicalRun(run);
  }

  async persistEvalHarnessResult(
    result: EvalHarnessExperimentResultLike,
    environment?: CanonicalEvalRun['environment']
  ): Promise<string> {
    return this.persistCanonicalRun(this.toCanonicalEvalHarnessResult(result, environment));
  }

  async persistRegressionReport(report: RegressionReportLike): Promise<string> {
    return this.persistCanonicalRun(this.toCanonicalRegressionReport(report));
  }

  async persistTestRun(summary: TestRunSummary): Promise<string> {
    return this.persistCanonicalRun(this.toCanonicalTestRun(summary));
  }
}
