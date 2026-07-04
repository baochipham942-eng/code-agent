import type { AgentTrajectoryEfficiency } from '../../../shared/contract/agentTrajectory';

export interface TrajectoryEfficiencyInputStep {
  type: string;
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    success: boolean;
    duration: number;
  };
}

export function calculateTrajectoryEfficiency(
  steps: TrajectoryEfficiencyInputStep[],
): AgentTrajectoryEfficiency {
  const totalSteps = steps.length;
  let redundantSteps = 0;
  let backtrackCount = 0;
  let totalDuration = 0;

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const curr = steps[i];
    if (
      prev.type === 'tool_call' &&
      curr.type === 'tool_call' &&
      prev.toolCall &&
      prev.toolCall.name === curr.toolCall?.name &&
      JSON.stringify(prev.toolCall.args) === JSON.stringify(curr.toolCall.args)
    ) {
      redundantSteps++;
      backtrackCount++;
    }
  }

  for (const step of steps) {
    if (step.type === 'tool_call' && step.toolCall) {
      totalDuration += step.toolCall.duration;
      if (!step.toolCall.success) redundantSteps++;
    }
  }

  redundantSteps = Math.min(redundantSteps, totalSteps);

  const effectiveSteps = Math.max(totalSteps - redundantSteps, 0);
  const efficiency = totalSteps > 0 ? effectiveSteps / totalSteps : 1;

  return {
    totalSteps,
    effectiveSteps,
    redundantSteps,
    backtrackCount,
    totalTokens: { input: 0, output: 0 },
    totalDuration,
    tokensPerEffectiveStep: 0,
    efficiency,
  };
}
