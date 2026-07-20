import { describe, expect, it, vi } from 'vitest';

import { ResearchExecutor } from '../../src/host/research/researchExecutor';
import type { ResearchPlan, ResearchStep } from '../../src/host/research/types';

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

describe('ResearchExecutor analysis error cause', () => {
  it('preserves the model error when adding analysis context', async () => {
    const originalError = new Error('model unavailable');
    const modelRouter = {
      chat: vi.fn().mockRejectedValue(originalError),
    };
    const executor = new ResearchExecutor(
      {} as never,
      modelRouter as never,
    ) as unknown as {
      executeAnalysisStep(step: ResearchStep, plan: ResearchPlan): Promise<string>;
    };
    const step: ResearchStep = {
      id: 'analysis-1',
      title: 'Analyze evidence',
      description: 'Synthesize prior findings',
      stepType: 'analysis',
      status: 'pending',
    };
    const plan: ResearchPlan = {
      topic: 'topic',
      clarifiedTopic: 'clarified topic',
      objectives: [],
      steps: [
        {
          id: 'research-1',
          title: 'Evidence',
          description: 'Collect evidence',
          stepType: 'research',
          status: 'completed',
          result: 'verified evidence',
        },
        step,
      ],
      expectedOutput: 'analysis',
      createdAt: 1,
    };

    const error = await captureError(executor.executeAnalysisStep(step, plan));

    expect(error.message).toBe('分析失败: model unavailable');
    expect(error.cause).toBe(originalError);
  });
});
