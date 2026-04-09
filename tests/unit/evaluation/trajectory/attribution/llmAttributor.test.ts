// ============================================================================
// llmAttributor tests — Self-Evolving v2.5 Phase 2
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { attributeByLLM } from '../../../../../src/main/evaluation/trajectory/attribution/llmAttributor';
import type {
  Trajectory,
  TrajectoryStep,
} from '../../../../../src/main/testing/types';

function toolStep(index: number, name: string, success: boolean): TrajectoryStep {
  return {
    index,
    timestamp: index * 100,
    type: 'tool_call',
    toolCall: { name, args: {}, success, duration: 10 },
  };
}

function makeTraj(steps: TrajectoryStep[]): Trajectory {
  return {
    id: 'traj_llm',
    sessionId: 'sess',
    startTime: 0,
    endTime: 1000,
    steps,
    deviations: [],
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
    summary: { intent: 'fix bug', outcome: 'failure', criticalPath: [] },
  };
}

describe('llmAttributor', () => {
  it('returns a valid root cause when LLM emits well-formed JSON', async () => {
    const llmFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        stepIndex: 2,
        category: 'bad_decision',
        summary: 'agent chose the wrong tool to inspect the file',
        evidence: [1, 2, 3],
        confidence: 0.82,
      })
    );
    const traj = makeTraj([
      toolStep(0, 'bash', true),
      toolStep(1, 'bash', false),
      toolStep(2, 'bash', false),
    ]);

    const result = await attributeByLLM(traj, llmFn);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('bad_decision');
    expect(result!.stepIndex).toBe(2);
    expect(result!.confidence).toBeCloseTo(0.82, 2);
    expect(llmFn).toHaveBeenCalledTimes(1);
    const prompt = llmFn.mock.calls[0][0];
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('returns null when LLM output is not JSON', async () => {
    const llmFn = vi.fn().mockResolvedValue('sorry, no idea');
    const traj = makeTraj([toolStep(0, 'bash', false)]);
    const result = await attributeByLLM(traj, llmFn);
    expect(result).toBeNull();
  });

  it('returns null when LLM throws', async () => {
    const llmFn = vi.fn().mockRejectedValue(new Error('network down'));
    const traj = makeTraj([toolStep(0, 'bash', false)]);
    const result = await attributeByLLM(traj, llmFn);
    expect(result).toBeNull();
  });

  it('returns null when LLM returns JSON with invalid category', async () => {
    const llmFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        stepIndex: 1,
        category: 'something-random',
        summary: 'bogus',
        evidence: [1],
        confidence: 0.7,
      })
    );
    const traj = makeTraj([toolStep(0, 'bash', false), toolStep(1, 'bash', false)]);
    const result = await attributeByLLM(traj, llmFn);
    expect(result).toBeNull();
  });

  it('accepts JSON wrapped in a fenced code block', async () => {
    const jsonPayload = JSON.stringify({
      stepIndex: 0,
      category: 'tool_error',
      summary: 'tool failed at start',
      evidence: [0],
      confidence: 0.7,
    });
    const llmFn = vi
      .fn()
      .mockResolvedValue('```json\n' + jsonPayload + '\n```');
    const traj = makeTraj([toolStep(0, 'bash', false)]);
    const result = await attributeByLLM(traj, llmFn);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('tool_error');
  });
});
