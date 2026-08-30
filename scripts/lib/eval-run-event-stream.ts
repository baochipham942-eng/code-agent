import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { TestEvent, TestRunSummary } from '../../src/host/testing/types';
import {
  EVAL_RUN_EVENT_SCHEMA_VERSION,
  type EvalRunEvent,
} from '../../src/shared/contract/evaluation';

export type EvalRunStartConfig = Extract<EvalRunEvent, { type: 'run_start' }>['config'];

export class EvalRunEventStream {
  readonly runId: string;
  private readonly startedAt = Date.now();
  private started = false;
  private ended = false;
  private summary?: TestRunSummary;
  private reportFiles: string[] = [];
  private expectedExitCode = 0;
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
          ...(event.result.costUsd !== undefined ? { costUsd: event.result.costUsd } : {}),
          ...(event.result.mockExcluded ? { mockExcluded: true } : {}),
          ...(event.result.killedByTimeout ? { killedByTimeout: true } : {}),
          ...(event.result.trials ? { trials: event.result.trials.length } : {}),
          ...(event.result.sessionId ? { sessionId: event.result.sessionId } : {}),
          ...(event.result.scoreAuthority ? { scoreAuthority: event.result.scoreAuthority } : {}),
          skillActivations: event.result.skillActivations,
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

  recordReportFiles(reportFiles: string[]): void {
    this.reportFiles = [...reportFiles];
  }

  setExpectedExitCode(exitCode: number): void {
    this.expectedExitCode = exitCode;
  }

  error(error: unknown): void {
    if (this.ended) return;
    const message = error instanceof Error ? error.message : String(error);
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
    const aborted = summary?.aborted === true || exitCode === 2;
    const abortReason = summary?.abortReason;
    this.write({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'run_end',
      ts: now,
      runId: this.runId,
      summary: summary
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
          },
      reportFiles: this.reportFiles,
      exitCode,
      aborted,
      ...(abortReason ? { abortReason } : {}),
    });
  }

  private write(event: EvalRunEvent): void {
    fs.writeSync(process.stdout.fd, `${JSON.stringify(event)}\n`);
  }
}
