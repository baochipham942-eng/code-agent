import { describe, expect, it } from 'vitest';

import { calculateTrajectoryEfficiency } from '../../../../src/host/evaluation/trajectory/trajectoryEfficiency';
import { TrajectoryBuilder } from '../../../../src/host/evaluation/trajectory/trajectoryBuilder';
import type { TrajectoryStep } from '../../../../src/host/testing/types';

describe('calculateTrajectoryEfficiency', () => {
  it('keeps the legacy TrajectoryBuilder efficiency formula byte-for-byte visible', () => {
    const steps: TrajectoryStep[] = [
      {
        index: 0,
        timestamp: 100,
        type: 'tool_call',
        toolCall: {
          name: 'Read',
          args: { file_path: 'package.json' },
          success: true,
          duration: 12,
        },
      },
      {
        index: 1,
        timestamp: 120,
        type: 'tool_call',
        toolCall: {
          name: 'Read',
          args: { file_path: 'package.json' },
          success: false,
          duration: 30,
        },
      },
      {
        index: 2,
        timestamp: 160,
        type: 'decision',
        decision: {
          reasoning: 'try a different path',
          chosenAction: 'thinking',
        },
      },
    ];

    expect(calculateTrajectoryEfficiency(steps)).toEqual({
      totalSteps: 3,
      effectiveSteps: 1,
      redundantSteps: 2,
      backtrackCount: 1,
      totalTokens: { input: 0, output: 0 },
      totalDuration: 42,
      tokensPerEffectiveStep: 0,
      efficiency: 1 / 3,
    });
  });

  it('matches TrajectoryBuilder output for paired tool events', () => {
    const trajectory = new TrajectoryBuilder().buildFromEvents([
      {
        event_type: 'tool_start',
        event_data: { tool: 'Read', args: { file_path: 'package.json' } },
        timestamp: '100',
      },
      {
        event_type: 'tool_result',
        event_data: { tool: 'Read', success: true, result: 'ok' },
        timestamp: '112',
      },
      {
        event_type: 'tool_start',
        event_data: { tool: 'Read', args: { file_path: 'package.json' } },
        timestamp: '120',
      },
      {
        event_type: 'tool_result',
        event_data: { tool: 'Read', success: false, error: 'missing file' },
        timestamp: '150',
      },
    ]);

    expect(trajectory.efficiency).toEqual(calculateTrajectoryEfficiency(trajectory.steps));
    expect(trajectory.efficiency).toEqual({
      totalSteps: 2,
      effectiveSteps: 0,
      redundantSteps: 2,
      backtrackCount: 1,
      totalTokens: { input: 0, output: 0 },
      totalDuration: 42,
      tokensPerEffectiveStep: 0,
      efficiency: 0,
    });
  });
});
