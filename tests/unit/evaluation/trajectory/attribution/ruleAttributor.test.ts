// ============================================================================
// ruleAttributor tests — Self-Evolving v2.5 Phase 2
// ============================================================================

import { describe, it, expect } from 'vitest';
import { attributeByRules } from '../../../../../src/main/evaluation/trajectory/attribution/ruleAttributor';
import type {
  Trajectory,
  TrajectoryStep,
  DeviationMarker,
  CausalChainNode,
} from '../../../../../src/main/testing/types';

/** Minimal trajectory builder for tests. */
function makeTrajectory(opts: {
  steps: TrajectoryStep[];
  deviations?: DeviationMarker[];
  outcome?: 'success' | 'partial' | 'failure';
}): Trajectory {
  return {
    id: 'traj_test',
    sessionId: 'sess_test',
    startTime: 0,
    endTime: 1000,
    steps: opts.steps,
    deviations: opts.deviations ?? [],
    recoveryPatterns: [],
    efficiency: {
      totalSteps: opts.steps.length,
      effectiveSteps: opts.steps.length,
      redundantSteps: 0,
      backtrackCount: 0,
      totalTokens: { input: 0, output: 0 },
      totalDuration: 0,
      tokensPerEffectiveStep: 0,
      efficiency: 1,
    },
    summary: {
      intent: 'test',
      outcome: opts.outcome ?? 'failure',
      criticalPath: [],
    },
  };
}

function toolStep(index: number, name: string, success: boolean): TrajectoryStep {
  return {
    index,
    timestamp: index * 100,
    type: 'tool_call',
    toolCall: { name, args: {}, success, duration: 10 },
  };
}

function errorStep(index: number, message: string): TrajectoryStep {
  return {
    index,
    timestamp: index * 100,
    type: 'error',
    error: { message, recoverable: true },
  };
}

describe('ruleAttributor', () => {
  it('attributes high-severity loop marker as root (category=loop)', () => {
    const steps = Array.from({ length: 8 }, (_, i) => toolStep(i, 'bash', true));
    const deviations: DeviationMarker[] = [
      {
        stepIndex: 2,
        type: 'loop',
        description: 'bash called 5 times consecutively',
        severity: 'high',
        suggestedFix: 'break loop',
      },
    ];
    const traj = makeTrajectory({ steps, deviations, outcome: 'failure' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause).toBeDefined();
    expect(attr.rootCause!.category).toBe('loop');
    expect(attr.rootCause!.stepIndex).toBe(2);
    expect(attr.rootCause!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(attr.llmUsed).toBe(false);
    expect(attr.outcome).toBe('failure');
  });

  it('maps hallucination marker to category hallucination', () => {
    const steps = [toolStep(0, 'read_file', true), toolStep(1, 'read_file', true)];
    const deviations: DeviationMarker[] = [
      {
        stepIndex: 1,
        type: 'hallucination',
        description: 'identical repeat',
        severity: 'critical',
      },
    ];
    const traj = makeTrajectory({ steps, deviations, outcome: 'partial' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause!.category).toBe('hallucination');
    expect(attr.rootCause!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects early tool_error propagation chain', () => {
    const steps: TrajectoryStep[] = [
      toolStep(0, 'bash', true),
      toolStep(1, 'read_file', false),
      toolStep(2, 'read_file', false),
      toolStep(3, 'bash', false),
      toolStep(4, 'bash', true),
    ];
    const traj = makeTrajectory({ steps, outcome: 'failure' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause).toBeDefined();
    expect(attr.rootCause!.category).toBe('tool_error');
    expect(attr.rootCause!.stepIndex).toBe(1);
    expect(attr.causalChain.length).toBeGreaterThanOrEqual(2);
    const propagations = attr.causalChain.filter(
      (n: CausalChainNode) => n.role === 'propagation'
    );
    expect(propagations.length).toBeGreaterThanOrEqual(2);
    const hasRoot = attr.causalChain.some((n: CausalChainNode) => n.role === 'root');
    expect(hasRoot).toBe(true);
  });

  it('classifies late-only failure as env_failure', () => {
    const steps: TrajectoryStep[] = [
      toolStep(0, 'read_file', true),
      toolStep(1, 'bash', true),
      toolStep(2, 'read_file', true),
      toolStep(3, 'bash', true),
      toolStep(4, 'bash', false),
    ];
    const traj = makeTrajectory({ steps, outcome: 'failure' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause).toBeDefined();
    expect(attr.rootCause!.category).toBe('env_failure');
    expect(attr.rootCause!.stepIndex).toBe(4);
  });

  it('returns no rootCause for successful trajectory', () => {
    const steps = [toolStep(0, 'bash', true), toolStep(1, 'read_file', true)];
    const traj = makeTrajectory({ steps, outcome: 'success' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause).toBeUndefined();
    expect(attr.causalChain).toEqual([]);
    expect(attr.outcome).toBe('success');
  });

  it('returns unknown category with low confidence for ambiguous partial outcome', () => {
    const steps = [toolStep(0, 'bash', true), toolStep(1, 'read_file', true)];
    const traj = makeTrajectory({ steps, outcome: 'partial' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause).toBeDefined();
    expect(attr.rootCause!.category).toBe('unknown');
    expect(attr.rootCause!.confidence).toBeLessThan(0.5);
  });

  it('uses error step in first 30% as root when no high-severity deviations', () => {
    const steps: TrajectoryStep[] = [
      toolStep(0, 'bash', true),
      errorStep(1, 'network timeout'),
      toolStep(2, 'bash', true),
      toolStep(3, 'bash', true),
      toolStep(4, 'bash', true),
      toolStep(5, 'bash', true),
      toolStep(6, 'bash', true),
      toolStep(7, 'bash', true),
      toolStep(8, 'bash', true),
      toolStep(9, 'bash', true),
    ];
    const traj = makeTrajectory({ steps, outcome: 'failure' });
    const attr = attributeByRules(traj);

    expect(attr.rootCause!.category).toBe('tool_error');
    expect(attr.rootCause!.stepIndex).toBe(1);
  });

  it('records durationMs as a non-negative number', () => {
    const steps = [toolStep(0, 'bash', true)];
    const traj = makeTrajectory({ steps, outcome: 'success' });
    const attr = attributeByRules(traj);
    expect(attr.durationMs).toBeGreaterThanOrEqual(0);
    expect(attr.relatedRegressionCases).toEqual([]);
  });
});
