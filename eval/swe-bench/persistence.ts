import * as fs from 'node:fs';
import * as path from 'node:path';

import { ExperimentAdapter } from '../../src/host/evaluation/experimentAdapter';
import type { DatabaseService } from '../../src/host/services/core/databaseService';
import type {
  CanonicalEvalCase,
  CanonicalEvalRun,
  EvalCaseStatus,
} from '../../src/shared/contract/evaluation';

export interface SweBenchRunResult {
  instance_id: string;
  repo?: string;
  model?: string;
  rounds_used?: number;
  finished?: boolean;
  passed?: boolean;
  status?: 'passed' | 'failed' | 'degraded';
  failure_reasons?: string[];
  formal_passed?: boolean;
  validation?: Record<string, unknown>;
  diff_shape_passed?: boolean;
  diff_shape_validation?: Record<string, unknown>;
  executable_validation?: {
    status?: string;
    duration_ms?: number;
    reason?: string;
    command?: string[] | null;
    exit_code?: number | null;
    fail_to_pass?: string[];
    test_labels?: string[];
    stdout_tail?: string;
    stderr_tail?: string;
  };
  judge?: {
    semantic_match?: number;
    matches_intent?: boolean;
    matches_implementation?: boolean;
    key_differences?: string[];
    reasoning?: string;
  } | null;
  tokens?: {
    input?: number;
    output?: number;
  };
}

export interface SweBenchRunFiles {
  runDir: string;
  runId: string;
  result: SweBenchRunResult;
  trace?: Array<Record<string, unknown>>;
  resultPath: string;
  replayResultPath: string;
  diffPath: string;
  standardPatchPath: string;
  tracePath: string;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function loadSweBenchRun(runDir: string): SweBenchRunFiles {
  const absoluteRunDir = path.resolve(runDir);
  const resultPath = path.join(absoluteRunDir, 'result.json');
  const replayResultPath = path.join(absoluteRunDir, 'replay-result.json');
  const tracePath = path.join(absoluteRunDir, 'trace.json');

  if (!fs.existsSync(resultPath)) {
    throw new Error(`SWE-bench result not found: ${resultPath}`);
  }

  const result = readJsonFile<SweBenchRunResult>(resultPath);
  const replay = fs.existsSync(replayResultPath)
    ? readJsonFile<Partial<SweBenchRunResult>>(replayResultPath)
    : null;

  return {
    runDir: absoluteRunDir,
    runId: path.basename(absoluteRunDir),
    result: {
      ...result,
      ...(result.diff_shape_validation ? {} : { diff_shape_validation: result.validation as Record<string, unknown> | undefined }),
      ...(result.diff_shape_passed === undefined && typeof result.formal_passed === 'boolean'
        ? { diff_shape_passed: result.formal_passed }
        : {}),
      ...(replay ? {
        passed: replay.passed ?? result.passed,
        status: replay.status ?? result.status,
        failure_reasons: replay.failure_reasons ?? result.failure_reasons,
        diff_shape_passed: replay.diff_shape_passed ?? result.diff_shape_passed,
        diff_shape_validation: replay.diff_shape_validation ?? result.diff_shape_validation ?? (result.validation as Record<string, unknown> | undefined),
        executable_validation: replay.executable_validation ?? result.executable_validation,
        judge: replay.judge ?? result.judge,
        finished: replay.finished ?? result.finished,
      } : {}),
    },
    trace: fs.existsSync(tracePath) ? readJsonFile<Array<Record<string, unknown>>>(tracePath) : undefined,
    resultPath,
    replayResultPath,
    diffPath: path.join(absoluteRunDir, 'agent.diff'),
    standardPatchPath: path.join(absoluteRunDir, 'standard.patch'),
    tracePath,
  };
}

function inferStartTime(runId: string, resultPath: string): number {
  const dateMatch = runId.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (dateMatch) {
    const parsed = Date.parse(`${dateMatch[1]}T00:00:00.000Z`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fs.statSync(resultPath).mtimeMs;
}

function normalizeScore(result: SweBenchRunResult): number {
  if (result.passed) return 100;
  const judgeScore = result.judge?.semantic_match;
  if (typeof judgeScore === 'number') {
    return Math.max(0, Math.min(100, judgeScore));
  }
  return result.executable_validation?.status === 'passed' ? 60 : 0;
}

function normalizeStatus(result: SweBenchRunResult): EvalCaseStatus {
  if (result.passed || result.status === 'passed') return 'passed';
  if (result.status === 'degraded') return 'partial';
  return 'failed';
}

function classifyFailureStage(result: SweBenchRunResult): string | undefined {
  const reasons = result.failure_reasons ?? [];
  if (reasons.some(reason => reason.startsWith('judge_'))) return 'llm_scoring';
  if (reasons.includes('executable_validation_failed')) return 'outcome_verification';
  if (reasons.includes('not_finished')) return 'self_repair_check';
  if (result.executable_validation?.status === 'failed') return 'outcome_verification';
  return result.passed ? undefined : 'outcome_verification';
}

function summarizeFailure(result: SweBenchRunResult): string | undefined {
  if (result.passed) return undefined;
  const reasons = result.failure_reasons ?? [];
  if (reasons.length > 0) return reasons.join(', ');
  return result.executable_validation?.reason || result.status || 'failed';
}

function extractToolTrace(trace: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  if (!trace) return [];
  return trace
    .filter(entry => typeof entry.tool === 'string')
    .map(entry => ({
      round: entry.round,
      tool: entry.tool,
      args: entry.args,
    }));
}

function inferProvider(model: string | undefined): string {
  if (!model) return 'unknown';
  if (/mimo|xiaomi/i.test(model)) return 'xiaomi';
  return 'unknown';
}

export function toCanonicalSweBenchRun(files: SweBenchRunFiles): CanonicalEvalRun {
  const { result, trace, runId } = files;
  const startTime = inferStartTime(runId, files.resultPath);
  const status = normalizeStatus(result);
  const score = normalizeScore(result);
  const caseResult: CanonicalEvalCase = {
    caseId: result.instance_id,
    status,
    score,
    durationMs: result.executable_validation?.duration_ms ?? 0,
    failureReason: summarizeFailure(result),
    failureStage: classifyFailureStage(result),
    metadata: {
      repo: result.repo,
      runDir: files.runDir,
      resultPath: files.resultPath,
      replayResultPath: files.replayResultPath,
      diffPath: files.diffPath,
      standardPatchPath: files.standardPatchPath,
      tracePath: files.tracePath,
      roundsUsed: result.rounds_used,
      finished: Boolean(result.finished),
      formalPassed: result.formal_passed,
      failureReasons: result.failure_reasons ?? [],
      diffShapePassed: result.diff_shape_passed,
      diffShapeValidation: result.diff_shape_validation,
      executableValidation: result.executable_validation,
      judge: result.judge,
      tokens: result.tokens,
      toolTrace: extractToolTrace(trace),
    },
  };

  return {
    schemaVersion: 1,
    runId,
    source: 'swe-bench',
    aggregation: 'swe_bench_gates',
    startTime,
    endTime: startTime + caseResult.durationMs,
    durationMs: caseResult.durationMs,
    name: runId,
    scope: 'swe-bench',
    environment: {
      generation: 'swe-bench-runner',
      model: result.model ?? 'unknown',
      provider: inferProvider(result.model),
      workingDirectory: path.dirname(path.dirname(files.runDir)),
    },
    totals: {
      total: 1,
      passed: status === 'passed' ? 1 : 0,
      failed: status === 'failed' ? 1 : 0,
      partial: status === 'partial' ? 1 : 0,
      skipped: 0,
      errored: 0,
      passRate: status === 'passed' ? 1 : 0,
      averageScore: score,
    },
    cases: [caseResult],
    config: {
      instanceId: result.instance_id,
      repo: result.repo,
      gates: ['finished', 'diff_shape', 'executable_validation', 'llm_judge'],
    },
    metadata: {
      status: result.status ?? (result.passed ? 'passed' : 'failed'),
      finished: Boolean(result.finished),
      failureReasons: result.failure_reasons ?? [],
      tokens: result.tokens,
    },
  };
}

export function persistSweBenchRun(db: Pick<DatabaseService, 'insertExperiment' | 'insertExperimentCases'>, runDir: string): string {
  const adapter = new ExperimentAdapter(db);
  return adapter.persistRun(toCanonicalSweBenchRun(loadSweBenchRun(runDir)));
}
