import type { TestCase, TestResult, TestRunnerConfig } from './types';
import { quickTask } from '../model/quickModel';
import { judgeDimensions } from './judge/dimensionJudge';

export async function attachAiReview(
  config: TestRunnerConfig,
  testCase: TestCase,
  result: TestResult,
  mockExecution: boolean,
): Promise<void> {
  if (!config.aiReview?.length || mockExecution) return;
  result.aiReview = await judgeDimensions(
    { testCase, result, dims: config.aiReview },
    async (prompt) => {
      const response = await quickTask(prompt, 512);
      if (!response.success || !response.content) {
        throw new Error(response.error ?? 'AI review returned no content');
      }
      return {
        content: response.content,
        judgeModel: `${response.provider ?? 'unknown'}/${response.model ?? 'unknown'}`,
      };
    },
  );
}
