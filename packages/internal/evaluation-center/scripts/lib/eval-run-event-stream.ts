import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ComparisonResult, TestEvent, TestRunSummary } from '@host/testing/types';
import {
  EVAL_RUN_EVENT_SCHEMA_VERSION,
  type EvalRunEvent,
  type EvalRunEventSummary,
} from '@shared/contract/evaluation';
import { buildCaseEvidence } from './eval-case-evidence';

export type EvalRunStartConfig = Extract<EvalRunEvent, { type: 'run_start' }>['config'];

export class EvalRunEventStream {
  readonly runId: string;
  private readonly startedAt = Date.now();
  private started = false;
  private ended = false;
  private summary?: TestRunSummary;
  private comparisonSummary?: EvalRunEventSummary;
  private reportFiles: string[] = [];
  private expectedExitCode = 0;
  private lastError?: string;
  private readonly pendingToolResults = new Map<
    string,
    Array<Extract<TestEvent, { type: 'tool_result' }>>
  >();
  private readonly skillActivations = new Map<string, Record<string, number>>();
  private readonly onProcessExit = (exitCode: number) => {
    this.finish(exitCode);
  };

  constructor(runId: string = randomUUID()) {
    this.runId = runId;
    process.once('exit', this.onProcessExit);
  }

  start(plannedCaseIds: string[], config: EvalRunStartConfig): void {
    if (this.started) return;
    this.started = true;
    this.write({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'run_start',
      ts: Date.now(),
      runId: this.runId,
      plannedCaseIds,
      config,
    });
  }

  forward(event: TestEvent, config: EvalRunStartConfig): void {
    switch (event.type) {
      case 'suite_start':
        this.start(event.plannedCaseIds, config);
        break;
      case 'case_start':
        this.write({
          schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
          type: 'case_start',
          ts: Date.now(),
          runId: this.runId,
          testId: event.testId,
          description: event.description,
        });
        break;
      case 'case_end':
        event.result.skillActivations = {
          ...(event.result.skillActivations ?? {}),
          ...(this.skillActivations.get(event.result.testId) ?? {}),
        };
        this.skillActivations.delete(event.result.testId);
        for (const toolExecution of event.result.toolExecutions) {
          this.forward({
            type: 'tool_call',
            testId: event.result.testId,
            tool: toolExecution.tool,
            input: toolExecution.input,
          }, config);
          const pendingResults = this.pendingToolResults.get(event.result.testId);
          const toolResult = pendingResults?.shift();
          if (toolResult) {
            this.write({ schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, ts: Date.now(), runId: this.runId, ...toolResult });
          }
        }
        this.pendingToolResults.delete(event.result.testId);
        this.write({
          schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
          type: 'case_end',
          ts: Date.now(),
          runId: this.runId,
          testId: event.result.testId,
          status: event.result.status,
          score: event.result.score,
          durationMs: event.result.duration,
          ...(event.result.failureReason ? { failureReason: event.result.failureReason } : {}),
          ...(event.result.failureStage ? { failureStage: event.result.failureStage } : {}),
          ...(event.result.failure ? { failure: event.result.failure } : {}),
          ...(event.result.usageStatus ? { usageStatus: event.result.usageStatus } : {}),
          ...(event.result.invalid ? { invalid: event.result.invalid } : {}),
          ...(event.result.costUsd !== undefined ? { costUsd: event.result.costUsd } : {}),
          ...(event.result.mockExcluded ? { mockExcluded: true } : {}),
          ...(event.result.killedByTimeout ? { killedByTimeout: true } : {}),
          ...(event.result.trials ? { trials: event.result.trials.length } : {}),
          ...(event.result.sessionId ? { sessionId: event.result.sessionId } : {}),
          ...(event.result.scoreAuthority ? { scoreAuthority: event.result.scoreAuthority } : {}),
          skillActivations: event.result.skillActivations,
          // N-EVAL-MEMORY：case_end 自带计数，桥优先用它（与 data_json 的同名字段同源）
          ...(event.result.memoryRecall ? { memoryInjections: event.result.memoryRecall.injections } : {}),
          ...(event.result.memoryWrites !== undefined ? { memoryWrites: event.result.memoryWrites } : {}),
          ...(event.result.aiReview ? { aiReview: event.result.aiReview } : {}),
          evidence: buildCaseEvidence(event.result),
          ...(event.result.trialAggregate ? { trialAggregate: event.result.trialAggregate } : {}),
        });
        break;
      case 'tool_call':
        this.write({ schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, ts: Date.now(), runId: this.runId, ...event });
        break;
      case 'tool_result':
        this.pendingToolResults.set(event.testId, [
          ...(this.pendingToolResults.get(event.testId) ?? []),
          event,
        ]);
        break;
      case 'error':
      case 'memory_injected':
      case 'memory_written':
      case 'subagent_spawned':
        this.write({ schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, ts: Date.now(), runId: this.runId, ...event });
        break;
      case 'skill_activated': {
        const activations = this.skillActivations.get(event.testId) ?? {};
        activations[event.name] = (activations[event.name] ?? 0) + 1;
        this.skillActivations.set(event.testId, activations);
        this.write({ schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION, ts: Date.now(), runId: this.runId, ...event });
        break;
      }
      case 'suite_end':
        this.recordSummary(event.summary);
        break;
    }
  }

  recordSummary(summary: TestRunSummary): void {
    this.summary = summary;
  }

  recordComparison(result: ComparisonResult): void {
    const shipGate = result.summary.shipGate;
    if (!shipGate) throw new Error('compare result is missing summary.shipGate');
    const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((total, count) => total + count, 0);
    const candidateStatuses: string[] = [];
    for (const comparison of result.cases) {
      const candidateIsA = comparison.assignment.A === 'candidate';
      const statusA = comparison.statusA ?? 'not_run';
      const statusB = comparison.statusB ?? 'not_run';
      const writeArm = (arm: 'baseline' | 'candidate') => {
        const isA = comparison.assignment.A === arm;
        const status = isA ? statusA : statusB;
        const score = isA ? comparison.passRateA : comparison.passRateB;
        const durationMs = isA ? comparison.durationA : comparison.durationB;
        this.write({
          schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
          type: 'case_end',
          ts: Date.now(),
          runId: this.runId,
          testId: comparison.testId,
          status,
          score,
          durationMs,
          arm,
        });
        if (arm === 'candidate') candidateStatuses.push(status);
      };
      writeArm('baseline');
      writeArm('candidate');
      this.write({
        schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
        type: 'pair_end',
        ts: Date.now(),
        runId: this.runId,
        testId: comparison.testId,
        statusA,
        statusB,
        assignment: comparison.assignment,
        assertionWinner: comparison.assertionWinner,
        referenceWinner: comparison.referenceWinner,
        ...(comparison.excludedReason ? { excludedReason: comparison.excludedReason } : {}),
        assertionPassA: comparison.passRateA,
        assertionPassB: comparison.passRateB,
        assertionCount: comparison.assertionCount,
        skillActivations: {
          baseline: sum(candidateIsA ? comparison.skillActivationsB : comparison.skillActivationsA),
          candidate: sum(candidateIsA ? comparison.skillActivationsA : comparison.skillActivationsB),
        },
        memoryInjections: {
          baseline: candidateIsA ? comparison.memoryInjectionsB : comparison.memoryInjectionsA,
          candidate: candidateIsA ? comparison.memoryInjectionsA : comparison.memoryInjectionsB,
        },
      });
    }
    const plannedCaseIds = result.cases.map((item) => item.testId);
    this.comparisonSummary = {
      runId: this.runId,
      startTime: result.timestamp,
      endTime: result.timestamp + result.duration,
      duration: result.duration,
      total: result.cases.length,
      passed: candidateStatuses.filter((status) => status === 'passed').length,
      failed: candidateStatuses.filter((status) => status === 'failed').length,
      skipped: candidateStatuses.filter((status) => status === 'skipped').length,
      partial: candidateStatuses.filter((status) => status === 'partial').length,
      averageScore: result.cases.length > 0
        ? result.cases.reduce((total, item) => {
            const score = item.assignment.A === 'candidate' ? item.passRateA : item.passRateB;
            return total + score;
          }, 0) / result.cases.length
        : 0,
      plannedCaseIds,
      completed: true,
      notRun: candidateStatuses.filter((status) => status === 'not_run').length,
      invalidCases: 0,
      failureDistribution: { unknown: 0 },
      aggregationRule: shipGate.calibre.k > 1 ? 'pass_caret_k' : 'pass_rate_k1',
      aggregationRuleVersion: shipGate.calibre.aggregationRuleVersion,
      compare: {
        totalCases: result.summary.totalCases,
        baselineWins: result.summary.baselineWins,
        candidateWins: result.summary.candidateWins,
        ties: result.summary.ties,
        excludedPairs: result.summary.excludedPairs ?? 0,
        skillNotActivatedPairs: result.summary.skillNotActivatedPairs ?? 0,
        pValue: result.summary.pValue ?? shipGate.pValue,
        shipGate,
      },
    };
  }

  recordReportFiles(reportFiles: string[]): void {
    this.reportFiles = [...reportFiles];
  }

  setExpectedExitCode(exitCode: number): void {
    this.expectedExitCode = exitCode;
  }

  error(error: unknown): void {
    if (this.ended) return;
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.write({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'error',
      ts: Date.now(),
      runId: this.runId,
      error: message,
    });
  }

  finish(exitCode = this.expectedExitCode): void {
    if (this.ended) return;
    this.ended = true;
    process.off('exit', this.onProcessExit);
    const now = Date.now();
    const summary = this.summary;
    const compareSummary = this.comparisonSummary;
    const aborted = summary?.aborted === true || exitCode === 2;
    const abortReason = summary?.abortReason;
    this.write({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'run_end',
      ts: now,
      runId: this.runId,
      summary: compareSummary ?? (summary
        ? {
            runId: summary.runId,
            startTime: summary.startTime,
            endTime: summary.endTime,
            duration: summary.duration,
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            skipped: summary.skipped,
            ...(summary.mockExcluded !== undefined ? { mockExcluded: summary.mockExcluded } : {}),
            partial: summary.partial,
            ...(summary.infraExcluded !== undefined ? { infraExcluded: summary.infraExcluded } : {}),
            ...(summary.costExceeded !== undefined ? { costExceeded: summary.costExceeded } : {}),
            averageScore: summary.averageScore,
            plannedCaseIds: summary.plannedCaseIds,
            completed: summary.completed,
            notRun: summary.notRun,
            ...(summary.retiredSkipped?.length ? { retiredSkipped: summary.retiredSkipped } : {}),
            invalidCases: summary.invalidCases,
            failureDistribution: summary.failureDistribution,
            failureCodebookSource: summary.failureCodebookSource,
            ...(summary.gitCommit ? { gitCommit: summary.gitCommit } : {}),
            ...(summary.persistenceWarning ? { persistenceWarning: summary.persistenceWarning } : {}),
            ...(summary.aborted !== undefined ? { aborted: summary.aborted } : {}),
            ...(summary.abortReason ? { abortReason: summary.abortReason } : {}),
            ...(summary.unstableCaseCount !== undefined ? { unstableCaseCount: summary.unstableCaseCount } : {}),
            ...(summary.averageStdDev !== undefined ? { averageStdDev: summary.averageStdDev } : {}),
            ...(summary.aggregationRule ? { aggregationRule: summary.aggregationRule } : {}),
            ...(summary.aggregationRuleVersion !== undefined
              ? { aggregationRuleVersion: summary.aggregationRuleVersion }
              : {}),
            ...(summary.dataset ? { dataset: summary.dataset } : {}),
            ...(this.reportFiles.length > 0 ? { reportFiles: this.reportFiles } : {}),
          }
        : {
            runId: this.runId,
            startTime: this.startedAt,
            endTime: now,
            duration: now - this.startedAt,
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            partial: 0,
            averageScore: 0,
            plannedCaseIds: [],
            completed: false,
            notRun: 0,
            invalidCases: 0,
            failureDistribution: { unknown: 0 },
            ...(aborted ? { aborted: true } : {}),
          }),
      reportFiles: this.reportFiles,
      exitCode,
      aborted,
      ...(abortReason ? { abortReason } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    });
  }

  private write(event: EvalRunEvent): void {
    fs.writeSync(process.stdout.fd, `${JSON.stringify(event)}\n`);
  }
}
