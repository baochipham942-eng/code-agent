// ============================================================================
// Decision Trace Builder - Lazy trace assembly for security decisions
// ============================================================================
//
// Only creates trace objects on deny/ask paths. Allow hot path = zero overhead.

import type { DecisionStep, DecisionTrace, DecisionLayer, DecisionOutcome } from '../../shared/contract/decisionTrace';

export class DecisionTraceBuilder {
  private toolName: string;
  private startTime: number;
  private steps: DecisionStep[] = [];

  constructor(toolName: string) {
    this.toolName = toolName;
    this.startTime = Date.now();
  }

  addStep(layer: DecisionLayer, rule: string, result: DecisionOutcome, reason: string): this {
    this.steps.push({
      layer,
      rule,
      result,
      reason,
      durationMs: Date.now() - this.startTime,
      timestamp: Date.now(),
    });
    return this;
  }

  build(finalOutcome: DecisionOutcome): DecisionTrace {
    return {
      toolName: this.toolName,
      finalOutcome,
      steps: this.steps,
      totalDurationMs: Date.now() - this.startTime,
    };
  }
}

/**
 * Factory function for creating a trace builder
 */
export function createTraceBuilder(toolName: string): DecisionTraceBuilder {
  return new DecisionTraceBuilder(toolName);
}

/**
 * Helper to create a single trace step (used by decision layers that
 * want to attach a step without owning the builder)
 */
export function createTraceStep(
  layer: DecisionLayer,
  rule: string,
  result: DecisionOutcome,
  reason: string,
  startTime: number
): DecisionStep {
  return {
    layer,
    rule,
    result,
    reason,
    durationMs: Date.now() - startTime,
    timestamp: Date.now(),
  };
}
