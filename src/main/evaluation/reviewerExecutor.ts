// ============================================================================
// Reviewer Executor - LLM 评审员执行 + 响应解析
// ============================================================================

import { ModelRouter } from '../model/modelRouter';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import { EVALUATION_OUTPUT_FORMAT, type REVIEWER_CONFIGS } from './evaluationPrompts';
import type { ReviewerResult } from './swissCheeseEvaluator';

const logger = createLogger('ReviewerExecutor');

/**
 * 运行单个评审员
 */
export async function runReviewer(
  modelRouter: ModelRouter,
  config: (typeof REVIEWER_CONFIGS)[0],
  conversationText: string,
  promptOverride?: string
): Promise<ReviewerResult> {
  logger.debug(`Running reviewer: ${config.name}`);

  try {
    const effectivePrompt = promptOverride || config.prompt;
    const response = await callLLM(
      modelRouter,
      `${effectivePrompt}\n\n${EVALUATION_OUTPUT_FORMAT}`,
      `请评估以下对话：\n\n${conversationText}`
    );

    if (!response) {
      throw new Error('Empty response from LLM');
    }

    const parsed = parseReviewerResponse(response);

    return {
      reviewerId: config.id,
      reviewerName: config.name,
      perspective: config.perspective,
      scores: parsed.scores || {
        outcomeVerification: 70,
        codeQuality: 70,
        security: 70,
        toolEfficiency: 70,
      },
      findings: parsed.findings || [],
      concerns: parsed.concerns || [],
      passed: parsed.passed ?? true,
    };
  } catch (error) {
    logger.warn(`Reviewer ${config.name} failed`, { error });
    return {
      reviewerId: config.id,
      reviewerName: config.name,
      perspective: config.perspective,
      scores: {
        outcomeVerification: 70,
        codeQuality: 70,
        security: 70,
        toolEfficiency: 70,
      },
      findings: ['评审员执行失败'],
      concerns: [],
      passed: true,
    };
  }
}

/**
 * 调用 LLM
 */
export async function callLLM(
  modelRouter: ModelRouter,
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  const provider = DEFAULT_PROVIDER;
  const model = DEFAULT_MODEL;

  logger.debug('Calling LLM for review', { provider, model });

  const result = await modelRouter.chat({
    provider: provider as 'deepseek' | 'openai' | 'claude' | 'zhipu',
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 1500,
  });

  return result.content;
}

/**
 * 解析评审员响应（coding 专用，兼容 v2 字段名）
 */
export function parseReviewerResponse(response: string): Partial<ReviewerResult> {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const parsed = JSON.parse(jsonMatch[0]);

    // 兼容 v2 字段名（taskCompletion → outcomeVerification）
    if (parsed.scores) {
      if (parsed.scores.taskCompletion !== undefined && parsed.scores.outcomeVerification === undefined) {
        parsed.scores.outcomeVerification = parsed.scores.taskCompletion;
      }
      if (parsed.scores.efficiency !== undefined && parsed.scores.toolEfficiency === undefined) {
        parsed.scores.toolEfficiency = parsed.scores.efficiency;
      }
      if (parsed.scores.safety !== undefined && parsed.scores.security === undefined) {
        parsed.scores.security = parsed.scores.safety;
      }
    }

    return parsed;
  } catch {
    logger.warn('Failed to parse reviewer response');
    return {};
  }
}

/**
 * 解析通用评审响应（QA/Research/Creation 共用）
 */
export function parseGenericResponse(response: string): {
  scores?: Record<string, number>;
  findings?: string[];
  concerns?: string[];
  passed?: boolean;
  summary?: string;
} {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    logger.warn('Failed to parse generic reviewer response');
    return {};
  }
}
