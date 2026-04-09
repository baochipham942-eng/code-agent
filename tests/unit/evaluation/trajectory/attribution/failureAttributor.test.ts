// ============================================================================
// failureAttributor (facade) tests — Self-Evolving v2.5 Phase 2
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { FailureAttributor } from '../../../../../src/main/evaluation/trajectory/attribution/failureAttributor';
import type {
  Trajectory,
  TrajectoryStep,
  DeviationMarker,
} from '../../../../../src/main/testing/types';

function toolStep(index: number, name: string, success: boolean): TrajectoryStep {
  return {
    index,
    timestamp: index * 100,
    type: 'tool_call',
    toolCall: { name, args: {}, success, duration: 10 },
  };
}

function makeTraj(
  steps: TrajectoryStep[],
  outcome: 'success' | 'partial' | 'failure' = 'failure',
  deviations: DeviationMarker[] = []
): Trajectory {
  return {
    id: 'traj_facade',
    sessionId: 'sess',
    startTime: 0,
    endTime: 1000,
    steps,
    deviations,
    recoveryPatterns: [],
    efficiency: {
      totalSteps: steps.length,
      effectiveSteps: steps.length,
      redundantSteps: 0,
      backtrackCount: 0,
      totalTokens: { input: 0, output: 0 },
      totalDuration: 0,
      tokensPerEffectiveStep: 0,
      efficiency: 1,
    },
    summary: { intent: 'test', outcome, criticalPath: [] },
  };
}

describe('FailureAttributor (facade)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-facade-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses only rules when enableLLM is false', async () => {
    const highDev: DeviationMarker = {
      stepIndex: 1,
      type: 'loop',
      description: 'loop',
      severity: 'high',
    };
    const traj = makeTraj(
      [toolStep(0, 'bash', true), toolStep(1, 'bash', true), toolStep(2, 'bash', true)],
      'failure',
      [highDev]
    );
    const attributor = new FailureAttributor();
    const result = await attributor.attribute(traj, {
      enableLLM: false,
      regressionCasesDir: tmpDir,
    });
    expect(result.llmUsed).toBe(false);
    expect(result.rootCause?.category).toBe('loop');
  });

  it('falls back to LLM when rule confidence is low and enableLLM=true', async () => {
    const traj = makeTraj(
      [toolStep(0, 'bash', true), toolStep(1, 'read_file', true)],
      'partial'
    );
    const llmFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        stepIndex: 1,
        category: 'missing_context',
        summary: 'agent lacked file content to proceed',
        evidence: [0, 1],
        confidence: 0.77,
      })
    );
    const attributor = new FailureAttributor();
    const result = await attributor.attribute(traj, {
      enableLLM: true,
      llmFn,
      regressionCasesDir: tmpDir,
    });
    expect(llmFn).toHaveBeenCalledTimes(1);
    expect(result.llmUsed).toBe(true);
    expect(result.rootCause?.category).toBe('missing_context');
    expect(result.rootCause?.confidence).toBeCloseTo(0.77, 2);
  });

  it('keeps rule result when LLM returns null', async () => {
    const traj = makeTraj(
      [toolStep(0, 'bash', true), toolStep(1, 'read_file', true)],
      'partial'
    );
    const llmFn = vi.fn().mockResolvedValue('garbage not json');
    const attributor = new FailureAttributor();
    const result = await attributor.attribute(traj, {
      enableLLM: true,
      llmFn,
      regressionCasesDir: tmpDir,
    });
    expect(result.llmUsed).toBe(false);
    expect(result.rootCause?.category).toBe('unknown');
  });

  it('enriches with regression case matches', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'reg-001.md'),
      `---
id: reg-001
source: test
tags: [bash, process]
related_rules: []
eval_command: "true"
---

## 场景
bash command with process env undefined problem

## 预期行为
ok
`
    );
    const traj = makeTraj(
      [toolStep(0, 'bash', false), toolStep(1, 'bash', false)],
      'failure'
    );
    // Inject an error step with matching keywords.
    traj.steps.push({
      index: 2,
      timestamp: 300,
      type: 'error',
      error: { message: 'process env undefined', recoverable: false },
    });

    const attributor = new FailureAttributor();
    const result = await attributor.attribute(traj, {
      enableLLM: false,
      regressionCasesDir: tmpDir,
    });
    expect(result.relatedRegressionCases).toContain('reg-001');
  });

  it('returns rule result for successful trajectories without calling LLM', async () => {
    const traj = makeTraj([toolStep(0, 'bash', true)], 'success');
    const llmFn = vi.fn().mockResolvedValue('{}');
    const attributor = new FailureAttributor();
    const result = await attributor.attribute(traj, {
      enableLLM: true,
      llmFn,
      regressionCasesDir: tmpDir,
    });
    expect(llmFn).not.toHaveBeenCalled();
    expect(result.rootCause).toBeUndefined();
    expect(result.llmUsed).toBe(false);
  });
});
