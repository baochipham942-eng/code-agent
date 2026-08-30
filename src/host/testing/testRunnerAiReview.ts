import type { TestCase, TestResult, TestRunnerConfig } from './types';
import { quickTask } from '../model/quickModel';
import { getAiReviewPromptHash, judgeDimensions } from './judge/dimensionJudge';

export async function attachAiReview(
  config: TestRunnerConfig,
  testCase: TestCase,
  result: TestResult,
  mockExecution: boolean,
): Promise<void> {
  if (!config.aiReview?.length || mockExecution) return;
  try {
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
  } catch (error) {
    const aiReview: NonNullable<TestResult['aiReview']> = {};
    for (const dimension of config.aiReview) {
      aiReview[dimension] = {
        verdict: 'unavailable',
        reasoning: error instanceof Error ? error.message : String(error),
        judgeModel: 'unknown',
        promptHash: getAiReviewPromptHash(dimension),
        reason: 'judge_error',
      };
    }
    result.aiReview = aiReview;
  }
}
