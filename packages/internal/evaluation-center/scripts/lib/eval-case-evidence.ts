import type { TestResult } from '@host/testing/types';
import type { EvalCaseEvidence } from '@shared/contract/evaluation';

const MAX_TOOL_CALLS = 60;
const MAX_INPUT_CHARS = 200;
const MAX_CHECK_VALUE_CHARS = 500;
const MAX_RESPONSE_CHARS = 2_000;
const MAX_EVIDENCE_BYTES = 64 * 1_024;

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function stringify(value: unknown, maxChars: number): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), maxChars);
  } catch (error) {
    return truncate(`[无法序列化：${error instanceof Error ? error.message : String(error)}]`, maxChars);
  }
}

function evidenceBytes(evidence: EvalCaseEvidence): number {
  return Buffer.byteLength(JSON.stringify(evidence), 'utf8');
}

/** Build the bounded, product-reachable evidence persisted with each case_end event. */
export function buildCaseEvidence(result: TestResult): EvalCaseEvidence {
  const lastResponse = result.responses.at(-1) ?? '';
  const allToolCalls = result.toolExecutions.map((execution) => ({
    tool: execution.tool,
    inputSummary: stringify(execution.input, MAX_INPUT_CHARS),
    ok: execution.success,
    ...(execution.error ? { error: execution.error } : {}),
    durationMs: execution.duration,
  }));
  let truncatedToolCalls = Math.max(0, allToolCalls.length - MAX_TOOL_CALLS);
  const evidence: EvalCaseEvidence = {
    prompt: result.prompt ?? '',
    ...(result.followUpPrompts?.length ? { followUpPrompts: [...result.followUpPrompts] } : {}),
    ...(result.simTurns?.some((turn) => turn.message) ? {
      simTurns: result.simTurns
        .filter((turn): turn is typeof turn & { message: string } => Boolean(turn.message))
        .map((turn) => ({
          turn: turn.responsesBefore + 2,
          userText: turn.message,
          matchedRule: turn.ruleId,
        })),
    } : {}),
    checks: (result.expectationResults ?? []).map((check) => ({
      type: check.expectation.type,
      passed: check.passed,
      expected: stringify(check.evidence.expected, MAX_CHECK_VALUE_CHARS),
      actual: stringify(check.evidence.actual, MAX_CHECK_VALUE_CHARS),
      ...(check.evidence.details
        ? { details: truncate(check.evidence.details, MAX_CHECK_VALUE_CHARS) }
        : {}),
      durationMs: check.duration,
    })),
    toolCalls: allToolCalls.slice(0, MAX_TOOL_CALLS),
    ...(truncatedToolCalls > 0 ? { toolCallsTruncated: truncatedToolCalls } : {}),
    responseExcerpt: lastResponse.slice(-MAX_RESPONSE_CHARS),
    responseTotalChars: lastResponse.length,
    ...(result.trials?.length ? {
      trialDetails: result.trials.map((trial, index) => ({
        index: index + 1,
        status: trial.status,
        score: trial.score,
        ...(trial.failureReason ? { failureReason: trial.failureReason } : {}),
        durationMs: trial.duration_ms,
      })),
    } : {}),
  };

  while (evidenceBytes(evidence) > MAX_EVIDENCE_BYTES && evidence.toolCalls.length > 0) {
    evidence.toolCalls.pop();
    truncatedToolCalls += 1;
    evidence.toolCallsTruncated = truncatedToolCalls;
  }
  while (evidenceBytes(evidence) > MAX_EVIDENCE_BYTES && evidence.responseExcerpt.length > 0) {
    evidence.responseExcerpt = evidence.responseExcerpt.slice(Math.min(200, evidence.responseExcerpt.length));
  }
  return evidence;
}
