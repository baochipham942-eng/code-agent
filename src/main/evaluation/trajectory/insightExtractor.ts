// ============================================================================
// Insight Extractor - Extract patterns from multiple trajectories
// ============================================================================

import type { Trajectory } from '../../testing/types';

interface TrajectoryInsight {
  pattern: string;
  frequency: number;
  impact: 'high' | 'medium' | 'low';
  suggestion: string;
}

/**
 * Aggregates data across multiple trajectories to surface recurring patterns,
 * common failure modes, and actionable suggestions.
 */
export class InsightExtractor {
  extractInsights(trajectories: Trajectory[]): TrajectoryInsight[] {
    if (trajectories.length === 0) return [];

    const insights: TrajectoryInsight[] = [];

    insights.push(...this.extractCommonErrors(trajectories));
    insights.push(...this.extractToolFailureRates(trajectories));
    insights.push(...this.extractBacktrackInsights(trajectories));
    insights.push(...this.extractRecoveryInsights(trajectories));
    insights.push(...this.extractDeviationInsights(trajectories));
    insights.push(...this.extractEfficiencyInsights(trajectories));

    // Deduplicate by pattern name
    const seen = new Set<string>();
    const unique: TrajectoryInsight[] = [];
    for (const insight of insights) {
      if (!seen.has(insight.pattern)) {
        seen.add(insight.pattern);
        unique.push(insight);
      }
    }

    // Sort: high impact first, then by frequency descending
    const impactOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    unique.sort((a, b) => {
      const impactDiff = impactOrder[a.impact] - impactOrder[b.impact];
      if (impactDiff !== 0) return impactDiff;
      return b.frequency - a.frequency;
    });

    return unique;
  }

  // ---- Insight extractors ----

  /**
   * Most common error types across trajectories.
   */
  private extractCommonErrors(trajectories: Trajectory[]): TrajectoryInsight[] {
    const errorCounts = new Map<string, number>();

    for (const traj of trajectories) {
      for (const step of traj.steps) {
        if (step.type === 'error' && step.error) {
          // Normalize error messages by taking the first 80 chars
          const key = step.error.message.slice(0, 80);
          errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const insights: TrajectoryInsight[] = [];
    for (const [error, count] of errorCounts) {
      if (count < 2) continue; // Only report recurring errors
      const freq = count / trajectories.length;

      insights.push({
        pattern: `Recurring error: "${error}"`,
        frequency: freq,
        impact: freq > 0.5 ? 'high' : freq > 0.2 ? 'medium' : 'low',
        suggestion: `This error occurs in ${(freq * 100).toFixed(0)}% of trajectories. Investigate root cause and add preventive handling.`,
      });
    }

    return insights;
  }

  /**
   * Tools with highest failure rates.
   */
  private extractToolFailureRates(trajectories: Trajectory[]): TrajectoryInsight[] {
    const toolStats = new Map<string, { calls: number; failures: number }>();

    for (const traj of trajectories) {
      for (const step of traj.steps) {
        if (step.type !== 'tool_call' || !step.toolCall) continue;
        const name = step.toolCall.name;
        const stats = toolStats.get(name) ?? { calls: 0, failures: 0 };
        stats.calls++;
        if (!step.toolCall.success) stats.failures++;
        toolStats.set(name, stats);
      }
    }

    const insights: TrajectoryInsight[] = [];
    for (const [tool, stats] of toolStats) {
      if (stats.calls < 3) continue; // Need enough samples
      const failureRate = stats.failures / stats.calls;
      if (failureRate < 0.1) continue; // Only report meaningful failure rates

      insights.push({
        pattern: `High failure rate for tool "${tool}"`,
        frequency: failureRate,
        impact: failureRate > 0.5 ? 'high' : failureRate > 0.25 ? 'medium' : 'low',
        suggestion:
          `"${tool}" fails ${(failureRate * 100).toFixed(0)}% of the time ` +
          `(${stats.failures}/${stats.calls} calls). ` +
          `Review common failure arguments and add validation or fallback.`,
      });
    }

    return insights;
  }

  /**
   * Average backtrack count per trajectory.
   */
  private extractBacktrackInsights(trajectories: Trajectory[]): TrajectoryInsight[] {
    const insights: TrajectoryInsight[] = [];
    const backtracks = trajectories.map(t => t.efficiency.backtrackCount);
    const avgBacktrack = backtracks.reduce((a, b) => a + b, 0) / trajectories.length;

    if (avgBacktrack >= 2) {
      insights.push({
        pattern: 'Frequent backtracking across trajectories',
        frequency: avgBacktrack / Math.max(...backtracks, 1),
        impact: avgBacktrack >= 5 ? 'high' : 'medium',
        suggestion:
          `Average ${avgBacktrack.toFixed(1)} backtracks per trajectory. ` +
          `Consider improving tool selection heuristics or adding planning steps.`,
      });
    }

    return insights;
  }

  /**
   * Recovery success rates.
   */
  private extractRecoveryInsights(trajectories: Trajectory[]): TrajectoryInsight[] {
    const insights: TrajectoryInsight[] = [];
    let totalRecoveries = 0;
    let successfulRecoveries = 0;
    const strategyCounts = new Map<string, { total: number; success: number }>();

    for (const traj of trajectories) {
      for (const rp of traj.recoveryPatterns) {
        totalRecoveries++;
        if (rp.successful) successfulRecoveries++;

        const stats = strategyCounts.get(rp.strategy) ?? { total: 0, success: 0 };
        stats.total++;
        if (rp.successful) stats.success++;
        strategyCounts.set(rp.strategy, stats);
      }
    }

    if (totalRecoveries >= 3) {
      const successRate = successfulRecoveries / totalRecoveries;
      insights.push({
        pattern: 'Recovery success rate',
        frequency: successRate,
        impact: successRate < 0.5 ? 'high' : successRate < 0.8 ? 'medium' : 'low',
        suggestion:
          `Recovery succeeds ${(successRate * 100).toFixed(0)}% of the time ` +
          `(${successfulRecoveries}/${totalRecoveries}). ` +
          (successRate < 0.5
            ? 'Recovery strategies need improvement — consider alternative approaches on failure.'
            : 'Recovery strategies are effective.'),
      });
    }

    // Per-strategy insights
    for (const [strategy, stats] of strategyCounts) {
      if (stats.total < 2) continue;
      const rate = stats.success / stats.total;
      if (rate < 0.5) {
        insights.push({
          pattern: `Low success rate for recovery strategy "${strategy}"`,
          frequency: rate,
          impact: 'medium',
          suggestion:
            `Strategy "${strategy}" succeeds only ${(rate * 100).toFixed(0)}% of the time. ` +
            `Consider switching to an alternative approach after initial failure.`,
        });
      }
    }

    return insights;
  }

  /**
   * Deviation frequency insights.
   */
  private extractDeviationInsights(trajectories: Trajectory[]): TrajectoryInsight[] {
    const insights: TrajectoryInsight[] = [];
    const deviationTypeCounts = new Map<string, number>();
    let totalDeviations = 0;

    for (const traj of trajectories) {
      for (const d of traj.deviations) {
        deviationTypeCounts.set(d.type, (deviationTypeCounts.get(d.type) ?? 0) + 1);
        totalDeviations++;
      }
    }

    for (const [type, count] of deviationTypeCounts) {
      const freq = count / trajectories.length;
      if (freq < 0.1) continue;

      insights.push({
        pattern: `Deviation pattern: ${type}`,
        frequency: freq,
        impact: type === 'loop' || type === 'hallucination' ? 'high' : 'medium',
        suggestion:
          `"${type}" deviations occur in ${(freq * 100).toFixed(0)}% of trajectories ` +
          `(${count} total). ${this.deviationAdvice(type)}`,
      });
    }

    return insights;
  }

  /**
   * Overall efficiency insights.
   */
  private extractEfficiencyInsights(trajectories: Trajectory[]): TrajectoryInsight[] {
    const insights: TrajectoryInsight[] = [];
    const efficiencies = trajectories.map(t => t.efficiency.efficiency);
    const avgEfficiency = efficiencies.reduce((a, b) => a + b, 0) / trajectories.length;

    if (avgEfficiency < 0.6) {
      insights.push({
        pattern: 'Low overall trajectory efficiency',
        frequency: 1 - avgEfficiency,
        impact: avgEfficiency < 0.4 ? 'high' : 'medium',
        suggestion:
          `Average efficiency is ${(avgEfficiency * 100).toFixed(0)}%. ` +
          `Many steps are redundant or failed. Focus on reducing loops and improving first-attempt success.`,
      });
    }

    return insights;
  }

  // ---- Helpers ----

  private deviationAdvice(type: string): string {
    switch (type) {
      case 'loop':
        return 'Add loop-breaking logic: check results before retrying and vary the approach.';
      case 'unnecessary_step':
        return 'Failed tool calls without recovery waste tokens. Add retry or fallback logic.';
      case 'wrong_args':
        return 'Validate tool arguments before calling. Add argument schema checks.';
      case 'hallucination':
        return 'Ensure tool results are incorporated into subsequent decisions.';
      default:
        return 'Review and address the root cause.';
    }
  }
}
