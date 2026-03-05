// ============================================================================
// Trajectory Comparator - Compare two trajectories
// ============================================================================

import type {
  Trajectory,
  TrajectoryDiff,
  TrajectoryStep,
} from '../../testing/types';

/**
 * Compares two trajectories and produces a diff summary.
 * Uses longest common subsequence (LCS) of tool call names to find shared structure,
 * then identifies the first divergence point and computes efficiency deltas.
 */
export class TrajectoryComparator {
  compare(a: Trajectory, b: Trajectory): TrajectoryDiff {
    const toolNamesA = this.extractToolNames(a.steps);
    const toolNamesB = this.extractToolNames(b.steps);

    const lcsLength = this.longestCommonSubsequence(toolNamesA, toolNamesB);
    const divergencePoint = this.findDivergencePoint(toolNamesA, toolNamesB);

    const effA = a.efficiency;
    const effB = b.efficiency;

    return {
      trajectoryA: a.id,
      trajectoryB: b.id,
      commonSteps: lcsLength,
      divergencePoint: divergencePoint ?? undefined,
      efficiencyDelta: {
        steps: effA.totalSteps - effB.totalSteps,
        tokens:
          (effA.totalTokens.input + effA.totalTokens.output) -
          (effB.totalTokens.input + effB.totalTokens.output),
        duration: effA.totalDuration - effB.totalDuration,
      },
    };
  }

  // ---- Internal helpers ----

  private extractToolNames(steps: TrajectoryStep[]): string[] {
    return steps
      .filter(s => s.type === 'tool_call' && s.toolCall)
      .map(s => s.toolCall!.name);
  }

  /**
   * Classic DP-based LCS length computation.
   */
  private longestCommonSubsequence(a: string[], b: string[]): number {
    const m = a.length;
    const n = b.length;

    // Use rolling two-row array for memory efficiency
    let prev = new Array<number>(n + 1).fill(0);
    let curr = new Array<number>(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      // Swap rows
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    return prev[n];
  }

  /**
   * Find the index of the first divergence between two tool name sequences.
   * Returns null if one sequence is a prefix of the other (or they are identical).
   */
  private findDivergencePoint(a: string[], b: string[]): number | null {
    const minLen = Math.min(a.length, b.length);

    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) return i;
    }

    // If lengths differ, divergence is at the end of the shorter sequence
    if (a.length !== b.length) return minLen;

    return null; // Identical sequences
  }
}
