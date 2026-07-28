// ============================================================================
// Experiment Adapter - runner outputs -> canonical eval run -> experiment DB
// ============================================================================

import { execSync } from 'child_process';
import { createHash } from 'node:crypto';
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
import {
  buildEvalReplayQualityReport,
  type ArtifactIssue,
} from '../../shared/contract/productClosure';

type ConversationAttributionWriter = Pick<
  DatabaseService,
  | 'getDb'
  | 'getSession'
  | 'replayConversationBranch'
  | 'recordConversationEvaluationAttribution'
>;

type ExperimentDbWriter =
  Pick<DatabaseService, 'insertExperiment' | 'insertExperimentCases'>
  & Partial<ConversationAttributionWriter>;

function supportsConversationAttribution(
  writer: ExperimentDbWriter,
): writer is ExperimentDbWriter & ConversationAttributionWriter {
  return (
    typeof writer.getDb === 'function'
    && typeof writer.getSession === 'function'
    && typeof writer.replayConversationBranch === 'function'
    && typeof writer.recordConversationEvaluationAttribution === 'function'
  );
}

export interface EvalHarnessExperimentResultLike {
  experimentId: string;
  /** 数据集/套件标识（可选）。存在时落盘实验名为 eval-harness-<dataset>-<日期>，
   *  评测中心基准 tab 按「source + 归一数据集名」分组才有意义；缺省保持旧格式。 */
  dataset?: string;
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

  /**
   * 数据集名安全化为实验名片段：空白/斜杠等转 `-`，压扁重复 `-`；
   * 整段形如日期/时间戳（2026-07-21 / 20260721 / 13 位 epoch）时加 `ds-` 前缀，
   * 避免被 renderer 侧归一函数（evalDatasetName.ts）当日期剥掉。返回空表示不可用。
   */
  private sanitizeDatasetSegment(raw: string): string | undefined {
    const sanitized = raw.trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!sanitized) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(sanitized) || /^\d{8}$/.test(sanitized) || /^\d{13}$/.test(sanitized)) {
      return `ds-${sanitized}`;
    }
    return sanitized;
  }

  private normalizeTestStatus(status: TestResult['status']): EvalCaseStatus {
    if (status === 'passed' || status === 'failed' || status === 'partial' || status === 'skipped') {
      return status;
    }
    // WP1-2：infra_excluded（429/超时/5xx/网络）在 canonical 层归 skipped
    // （不进能力分母），metadata.infraExcluded 保留可追溯性。
    if (status === 'infra_excluded' || status === 'cost_exceeded') {
      return 'skipped';
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
      // F2（ADR-036）：pass-rate 分母与均分口径统一——都排除 skipped（基础设施故障
      // 不进能力分母）。之前用 total（含 skipped）会让 skipped 稀释 pass-rate 而不进均分。
      passRate: scored.length > 0 ? passed / scored.length : 0,
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
    const qualityReport = this.buildCaseQualityReport(run, c);
    return JSON.stringify({
      ...(c.metadata || {}),
      sessionId: c.sessionId,
      replayKey: c.replayKey,
      telemetryCompleteness: c.telemetryCompleteness,
      qualityReport,
      failureReason: c.failureReason,
      failureStage: c.failureStage,
      aggregation: run.aggregation,
      source: run.source,
      score100: c.score,
      ...(c.scoreAuthority ? { scoreAuthority: c.scoreAuthority } : {}),
      ...(c.trials ? { trials: c.trials } : {}),
    });
  }

  private buildCaseQualityReport(run: CanonicalEvalRun, c: CanonicalEvalCase) {
    if (!c.sessionId) return undefined;
    const traceIdentity = buildSessionTraceIdentity(c.sessionId);
    const realAgentRun = c.metadata?.realAgentRun as { reasons?: string[]; gateFailures?: string[]; failureReasons?: string[] } | undefined;
    const gateFailures = Array.from(new Set([
      ...(realAgentRun?.reasons || []),
      ...(realAgentRun?.gateFailures || []),
      ...(realAgentRun?.failureReasons || []),
    ]));
    const artifactIssues = Array.isArray(c.metadata?.artifactIssues)
      ? c.metadata.artifactIssues as ArtifactIssue[]
      : undefined;

    return buildEvalReplayQualityReport({
      reportId: `quality:${run.runId}:${c.caseId}`,
      traceIdentity,
      telemetryCompleteness: c.telemetryCompleteness,
      gateFailures,
      artifactIssues,
      createdAt: run.endTime ?? run.startTime,
      runId: run.runId,
      caseId: c.caseId,
    });
  }

  /**
   * Attach the canonical case score to the immutable entries that were active
   * when the evaluated branch was persisted. Provider-native runtime identity
   * is deliberately not consulted: `runId` is the local canonical eval run.
   */
  private persistConversationAttributions(
    writer: ExperimentDbWriter & ConversationAttributionWriter,
    run: CanonicalEvalRun,
    experimentId: string,
  ): void {
    for (const evalCase of run.cases) {
      if (!evalCase.sessionId) continue;
      const session = writer.getSession(evalCase.sessionId);
      if (!session) continue;
      const boundary = {
        ownerUserId: session.userId ?? null,
        projectId: session.projectId ?? null,
      };
      const replay = writer.replayConversationBranch(evalCase.sessionId, boundary);
      const attributedMessageIds = replay.messages.map((message) => message.projectedMessageId);
      if (attributedMessageIds.length === 0) continue;

      const evaluationId = `canonical-eval:${experimentId}:${evalCase.caseId}`;
      const idempotencyKey = `canonical-eval-attribution:${createHash('sha256')
        .update(JSON.stringify({
          schemaVersion: 1,
          experimentId,
          caseId: evalCase.caseId,
          sessionId: evalCase.sessionId,
        }))
        .digest('hex')}`;
      writer.recordConversationEvaluationAttribution({
        sessionId: evalCase.sessionId,
        boundary,
        evaluationId,
        runId: experimentId,
        metric: 'canonical_score_100',
        value: evalCase.score,
        attributedMessageIds,
        idempotencyKey,
        createdAt: run.endTime ?? run.startTime,
      });
    }
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

    const persist = (): void => {
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

      if (supportsConversationAttribution(this.db)) {
        this.persistConversationAttributions(this.db, run, experimentId);
      }
    };

    if (supportsConversationAttribution(this.db)) {
      const rawDb = this.db.getDb();
      if (!rawDb) {
        throw new Error('canonical eval attribution requires an initialized transaction database');
      }
      rawDb.transaction(persist)();
    } else {
      persist();
    }

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
        scoreAuthority: r.scoreAuthority,
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
          ...(r.killedByTimeout ? { killedByTimeout: true } : {}),
          ...(r.status === 'infra_excluded' ? { infraExcluded: true } : {}),
          ...(r.status === 'cost_exceeded'
            ? {
                costExceeded: true,
                costUsd: r.costUsd,
                costLimitUsd: r.costLimitUsd,
              }
            : {}),
          ...(r.variance !== undefined ? { variance: r.variance, stdDev: r.stdDev, unstable: r.unstable } : {}),
        },
      };
    });

    const day = new Date(summary.startTime).toISOString().slice(0, 10);
    const datasetSegment = summary.dataset ? this.sanitizeDatasetSegment(summary.dataset) : undefined;
    return {
      schemaVersion: 1,
      runId: summary.runId || crypto.randomUUID(),
      source: 'test-runner',
      aggregation,
      startTime: summary.startTime,
      endTime: summary.endTime,
      durationMs: summary.duration || 0,
      // GAP-017: harness 对照实验用变体名命名，便于跨实验对比时识别维度；
      // 裸 eval 形态带数据集名（eval-<dataset>-<日期>），基准 tab 按数据集分组才成立
      name: summary.harness
        ? `harness-${summary.harness.name}-${day}`
        : datasetSegment
          ? `eval-${datasetSegment}-${day}`
          : `eval-${day}`,
      scope: 'full',
      environment: summary.environment,
      totals: this.computeTotals(cases),
      cases,
      gitCommit: summary.gitCommit,
      config: {
        workingDirectory: summary.environment?.workingDirectory,
        // GAP-017: harness 配置维度落 config_json（固定模型变 harness 的 ablation 对比依据）
        ...(summary.harness ? { harness: summary.harness } : {}),
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
        // WP1-4: prompt 改动预测登记（对账证据链落 DB）
        ...(summary.prediction ? { prediction: summary.prediction } : {}),
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
        // F1（ADR-036）：eval-harness 的 medianScore 由 LLM grader 产出（见
        // ExperimentRunner「LLM grader failed」路径），此前 canonical 映射整个丢了
        // scoreAuthority → 下游按 unknown 处理，LLM 分冒充确定性分进 headline。
        // 如实标注：非 degraded = llm_judge（本路径无校准记录，默认未校准）；
        // degraded 是确定性 replay gate 判失败，score 被强制归零，标 deterministic。
        scoreAuthority: gateDegraded ? 'deterministic_assertion' : 'llm_judge',
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
    const day = new Date(startTime).toISOString().slice(0, 10);
    const datasetSegment = result.dataset ? this.sanitizeDatasetSegment(result.dataset) : undefined;
    return {
      schemaVersion: 1,
      runId: result.experimentId || crypto.randomUUID(),
      source: 'eval-harness',
      aggregation: 'median_threshold',
      startTime,
      durationMs: cases.reduce((sum, c) => sum + c.durationMs, 0),
      name: datasetSegment ? `eval-harness-${datasetSegment}-${day}` : `eval-harness-${day}`,
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
