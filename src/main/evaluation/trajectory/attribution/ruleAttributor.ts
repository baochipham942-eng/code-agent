// ============================================================================
// Rule Attributor — Self-Evolving v2.5 Phase 2
//
// 规则优先的 Trajectory 根因定位。不调用 LLM。
// 规则优先级（自上而下）：
//   1) 首个 high/critical severity DeviationMarker → root（类型映射到 category）
//   2) trajectory 前 30% 内的首个 error step 或 failed tool_call → root(tool_error)
//   3) 末尾 5 步内的 failed tool_call → root(env_failure)
//   4) 都不匹配且 outcome !== success → root(unknown, 低置信度)
//   5) outcome === success → 不归因
// ============================================================================

import type {
  Trajectory,
  TrajectoryStep,
  DeviationMarker,
  FailureAttribution,
  FailureCategory,
  FailureRootCause,
  CausalChainNode,
} from '../../../testing/types';

const HIGH_SEVERITIES: ReadonlySet<DeviationMarker['severity']> = new Set(['high', 'critical']);

function mapDeviationTypeToCategory(type: DeviationMarker['type']): FailureCategory {
  switch (type) {
    case 'loop':
      return 'loop';
    case 'hallucination':
      return 'hallucination';
    case 'wrong_args':
    case 'wrong_tool':
    case 'missed_step':
      return 'bad_decision';
    case 'unnecessary_step':
      return 'tool_error';
    default:
      return 'unknown';
  }
}

function isFailedToolCall(step: TrajectoryStep): boolean {
  return step.type === 'tool_call' && !!step.toolCall && !step.toolCall.success;
}

function isErrorStep(step: TrajectoryStep): boolean {
  return step.type === 'error';
}

function summarizeStep(step: TrajectoryStep): string {
  if (step.type === 'tool_call' && step.toolCall) {
    return `tool "${step.toolCall.name}" ${step.toolCall.success ? 'succeeded' : 'failed'}`;
  }
  if (step.type === 'error' && step.error) {
    return `error: ${step.error.message.slice(0, 120)}`;
  }
  return step.type;
}

/**
 * Build a causal chain from root step onward.
 * - root node for the root step
 * - propagation nodes for every downstream failed tool_call / error step
 * - terminal node for the final step if trajectory didn't succeed
 */
function buildCausalChain(
  steps: TrajectoryStep[],
  rootIndex: number,
  outcome: Trajectory['summary']['outcome']
): CausalChainNode[] {
  const chain: CausalChainNode[] = [];

  const rootStep = steps.find((s) => s.index === rootIndex);
  if (rootStep) {
    chain.push({
      stepIndex: rootIndex,
      role: 'root',
      note: summarizeStep(rootStep),
    });
  }

  for (const step of steps) {
    if (step.index <= rootIndex) continue;
    if (isFailedToolCall(step) || isErrorStep(step)) {
      chain.push({
        stepIndex: step.index,
        role: 'propagation',
        note: summarizeStep(step),
      });
    }
  }

  if (outcome !== 'success' && steps.length > 0) {
    const last = steps[steps.length - 1];
    if (last.index !== rootIndex && !chain.some((n) => n.stepIndex === last.index)) {
      chain.push({
        stepIndex: last.index,
        role: 'terminal',
        note: summarizeStep(last),
      });
    }
  }

  return chain;
}

/**
 * Pure rule-based failure attribution.
 * Produces FailureAttribution without LLM or regression case matching.
 * Caller (failureAttributor) enriches with llmAttributor / regressionMatcher.
 */
export function attributeByRules(trajectory: Trajectory): FailureAttribution {
  const start = Date.now();
  const { steps, deviations, summary } = trajectory;
  const outcome = summary.outcome;

  // Successful trajectory: skip attribution.
  if (outcome === 'success') {
    return {
      trajectoryId: trajectory.id,
      outcome,
      causalChain: [],
      relatedRegressionCases: [],
      llmUsed: false,
      durationMs: Math.max(0, Date.now() - start),
    };
  }

  let rootCause: FailureRootCause | undefined;

  // Rule 1: first high/critical-severity deviation.
  const highDeviation = deviations.find((d) => HIGH_SEVERITIES.has(d.severity));
  if (highDeviation) {
    rootCause = {
      stepIndex: highDeviation.stepIndex,
      category: mapDeviationTypeToCategory(highDeviation.type),
      summary: highDeviation.description,
      evidence: deviations
        .filter((d) => d.stepIndex >= highDeviation.stepIndex)
        .map((d) => d.stepIndex),
      confidence: 0.9,
    };
  }

  // Rule 2: early failure (within first 30%).
  if (!rootCause && steps.length > 0) {
    const earlyThreshold = Math.max(1, Math.ceil(steps.length * 0.3));
    const earlyFailure = steps
      .slice(0, earlyThreshold)
      .find((s) => isErrorStep(s) || isFailedToolCall(s));
    if (earlyFailure) {
      rootCause = {
        stepIndex: earlyFailure.index,
        category: 'tool_error',
        summary: summarizeStep(earlyFailure),
        evidence: [earlyFailure.index],
        confidence: 0.75,
      };
    }
  }

  // Rule 3: late-only failure → env_failure.
  if (!rootCause && steps.length > 0) {
    const tailStart = Math.max(0, steps.length - 5);
    const tailFailure = steps
      .slice(tailStart)
      .find((s) => isErrorStep(s) || isFailedToolCall(s));
    if (tailFailure) {
      rootCause = {
        stepIndex: tailFailure.index,
        category: 'env_failure',
        summary: summarizeStep(tailFailure),
        evidence: [tailFailure.index],
        confidence: 0.6,
      };
    }
  }

  // Rule 4: fallback unknown.
  if (!rootCause) {
    const fallbackIndex = steps.length > 0 ? steps[steps.length - 1].index : 0;
    rootCause = {
      stepIndex: fallbackIndex,
      category: 'unknown',
      summary: 'No clear deviation or failed step detected; outcome not success',
      evidence: [],
      confidence: 0.3,
    };
  }

  const causalChain = buildCausalChain(steps, rootCause.stepIndex, outcome);

  return {
    trajectoryId: trajectory.id,
    outcome,
    rootCause,
    causalChain,
    relatedRegressionCases: [],
    llmUsed: false,
    durationMs: Math.max(0, Date.now() - start),
  };
}
