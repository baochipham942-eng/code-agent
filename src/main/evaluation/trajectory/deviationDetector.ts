// ============================================================================
// Deviation Detector - Rule-based deviation detection (no LLM needed)
// ============================================================================

import type {
  Trajectory,
  TrajectoryStep,
  DeviationMarker,
} from '../../testing/types';

/**
 * Rule-based deviation detector.
 * Applies heuristic rules to identify problematic patterns in a trajectory.
 */
export class DeviationDetector {
  detectByRules(trajectory: Trajectory): DeviationMarker[] {
    const markers: DeviationMarker[] = [];

    markers.push(...this.detectLoops(trajectory.steps));
    markers.push(...this.detectUnnecessarySteps(trajectory.steps));
    markers.push(...this.detectWrongArgs(trajectory.steps));
    markers.push(...this.detectHallucinations(trajectory.steps));

    // Sort by step index for deterministic output
    markers.sort((a, b) => a.stepIndex - b.stepIndex);

    return markers;
  }

  // ---- Rules ----

  /**
   * Loop detection: same tool + similar args called 3+ times consecutively.
   */
  private detectLoops(steps: TrajectoryStep[]): DeviationMarker[] {
    const markers: DeviationMarker[] = [];
    const toolSteps = steps.filter(s => s.type === 'tool_call' && s.toolCall);

    let runStart = 0;
    let runCount = 1;

    for (let i = 1; i < toolSteps.length; i++) {
      const prev = toolSteps[i - 1];
      const curr = toolSteps[i];

      if (
        prev.toolCall!.name === curr.toolCall!.name &&
        this.argsAreSimilar(prev.toolCall!.args, curr.toolCall!.args)
      ) {
        runCount++;
      } else {
        if (runCount >= 3) {
          markers.push({
            stepIndex: toolSteps[runStart].index,
            type: 'loop',
            description:
              `Tool "${toolSteps[runStart].toolCall!.name}" called ${runCount} times consecutively with similar args`,
            severity: runCount >= 5 ? 'high' : 'medium',
            suggestedFix: 'Break the loop by varying the approach or checking results before retrying',
          });
        }
        runStart = i;
        runCount = 1;
      }
    }

    // Check trailing run
    if (runCount >= 3) {
      markers.push({
        stepIndex: toolSteps[runStart].index,
        type: 'loop',
        description:
          `Tool "${toolSteps[runStart].toolCall!.name}" called ${runCount} times consecutively with similar args`,
        severity: runCount >= 5 ? 'high' : 'medium',
        suggestedFix: 'Break the loop by varying the approach or checking results before retrying',
      });
    }

    return markers;
  }

  /**
   * Unnecessary steps: tool call failed with no subsequent recovery attempt.
   */
  private detectUnnecessarySteps(steps: TrajectoryStep[]): DeviationMarker[] {
    const markers: DeviationMarker[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type !== 'tool_call' || !step.toolCall || step.toolCall.success) continue;

      // Check if there is a recovery attempt (same tool called again within next 5 steps)
      let hasRecovery = false;
      for (let j = i + 1; j < steps.length && j <= i + 5; j++) {
        const next = steps[j];
        if (
          next.type === 'tool_call' &&
          next.toolCall?.name === step.toolCall.name
        ) {
          hasRecovery = true;
          break;
        }
      }

      if (!hasRecovery) {
        markers.push({
          stepIndex: i,
          type: 'unnecessary_step',
          description:
            `Tool "${step.toolCall.name}" failed with no subsequent recovery or retry`,
          severity: 'low',
          suggestedFix: 'Consider retrying with corrected arguments or using an alternative tool',
        });
      }
    }

    return markers;
  }

  /**
   * Wrong args: bash call with empty command, or tool call with empty/missing critical args.
   */
  private detectWrongArgs(steps: TrajectoryStep[]): DeviationMarker[] {
    const markers: DeviationMarker[] = [];

    for (const step of steps) {
      if (step.type !== 'tool_call' || !step.toolCall) continue;

      const { name, args } = step.toolCall;

      // Bash with empty command
      if (
        (name === 'bash' || name === 'Bash' || name === 'execute_command') &&
        (!args.command || String(args.command).trim() === '')
      ) {
        markers.push({
          stepIndex: step.index,
          type: 'wrong_args',
          description: 'Bash tool called with empty command',
          severity: 'medium',
          suggestedFix: 'Provide a valid command string',
        });
      }

      // File read/write with empty path
      if (
        (name === 'read_file' || name === 'Read' || name === 'write_file' || name === 'Write') &&
        (!args.file_path && !args.path || (args.file_path && String(args.file_path).trim() === ''))
      ) {
        markers.push({
          stepIndex: step.index,
          type: 'wrong_args',
          description: `${name} called with empty file path`,
          severity: 'medium',
          suggestedFix: 'Provide a valid file path',
        });
      }
    }

    return markers;
  }

  /**
   * Hallucination heuristic: tool result ignored — a successful tool call
   * followed by calling the exact same tool with the exact same args (as if
   * the result was not observed).
   */
  private detectHallucinations(steps: TrajectoryStep[]): DeviationMarker[] {
    const markers: DeviationMarker[] = [];
    const toolSteps = steps.filter(s => s.type === 'tool_call' && s.toolCall);

    for (let i = 0; i < toolSteps.length - 1; i++) {
      const curr = toolSteps[i];
      const next = toolSteps[i + 1];

      if (
        curr.toolCall!.success &&
        next.toolCall!.name === curr.toolCall!.name &&
        JSON.stringify(next.toolCall!.args) === JSON.stringify(curr.toolCall!.args) &&
        next.toolCall!.success
      ) {
        markers.push({
          stepIndex: next.index,
          type: 'hallucination',
          description:
            `Tool "${curr.toolCall!.name}" called again with identical args after a successful call — result may have been ignored`,
          severity: 'medium',
          suggestedFix: 'Use the result of the previous call instead of repeating it',
        });
      }
    }

    return markers;
  }

  // ---- Helpers ----

  /**
   * Shallow similarity check for tool args.
   * Returns true if the args have the same keys and similar string values.
   */
  private argsAreSimilar(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;
    if (keysA.length === 0) return true;

    let matching = 0;
    for (const key of keysA) {
      if (!(key in b)) return false;
      const va = String(a[key] ?? '');
      const vb = String(b[key] ?? '');
      // Exact match or values share >80% of the shorter string
      if (va === vb || this.stringSimilarity(va, vb) > 0.8) {
        matching++;
      }
    }

    return matching === keysA.length;
  }

  /**
   * Simple string similarity: ratio of common characters to total length.
   */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const longer = a.length >= b.length ? a : b;
    const shorter = a.length >= b.length ? b : a;

    // Check prefix similarity for quick approximation
    let commonPrefix = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] === longer[i]) commonPrefix++;
      else break;
    }

    return commonPrefix / longer.length;
  }
}
