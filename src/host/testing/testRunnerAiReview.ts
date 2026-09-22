import type { TestCase, TestResult, TestRunnerConfig } from './types';
import { quickTask } from '../model/quickModel';
import { resolveProviderApiKey } from '../model/providers/providerResolution';
import { systemOne } from '../model/providers/typesafeProvider';
import { JEV_MODEL } from '../../shared/constants/jevQuestions';
import {
  getAiReviewPromptHash,
  judgeDimensions,
  type DimensionJudgePrescreen,
} from './judge/dimensionJudge';

/**
 * 发布前判官 Jev 初筛开关（默认关，与 CODE_AGENT_POSTLAUNCH_JEV_PRESCREEN 同一惯例：
 * 能力默认关，显式开启）。开且 key 能解析到才装配 systemOne；否则 undefined（生成式路径）。
 */
function isDimJudgeJevPrescreenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_DIMJUDGE_JEV_PRESCREEN === '1';
}

/**
 * 评测实验开关（N-JEV-DIMJUDGE-WIRE3，默认关）：接电 requiresExpectation 三维进判官。
 * 与 Jev 初筛开关独立——只开它时三维走生成式判官，两个都开时三维走初筛+升级。
 */
function isDimJudgeExpectationDimsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_DIMJUDGE_EXPECTATION_DIMS === '1';
}

const DIMJUDGE_PRESCREEN_MISSING_KEY_WARN
  = 'CODE_AGENT_DIMJUDGE_JEV_PRESCREEN 已开启但 TYPESAFE_API_KEY 缺失，Jev 初筛不生效（走生成式判官）';

/** 缺 key 的 warn 每进程只打一次——逐 case 打会把长评测刷屏（ai-review #2017 Nit）。 */
let missingKeyWarned = false;

function resolveDimensionPrescreen(): DimensionJudgePrescreen | undefined {
  if (!isDimJudgeJevPrescreenEnabled()) return undefined;
  const apiKey = resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL });
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn(DIMJUDGE_PRESCREEN_MISSING_KEY_WARN);
    }
    return undefined;
  }
  return (state, questions) => systemOne(state, questions);
}

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
      { prescreen: resolveDimensionPrescreen(), judgeExpectationDims: isDimJudgeExpectationDimsEnabled() },
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
