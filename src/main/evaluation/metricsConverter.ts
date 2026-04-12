// ============================================================================
// Metrics Converter - SwissCheeseResult → EvaluationMetric 转换
// ============================================================================

import type { EvaluationMetric } from '../../shared/contract/evaluation';
import { EvaluationDimension } from '../../shared/contract/evaluation';
import type { SwissCheeseResult } from './swissCheeseEvaluator';

/**
 * 将 SwissCheeseResult 转换为标准 EvaluationMetric 格式（根据 conversationType 适配）
 */
export function convertToMetrics(result: SwissCheeseResult): EvaluationMetric[] {
  switch (result.conversationType) {
    case 'qa':
      return convertQAMetrics(result);
    case 'research':
      return convertResearchMetrics(result);
    case 'creation':
      return convertCreationMetrics(result);
    case 'coding':
    default:
      return convertCodingMetrics(result);
  }
}

/**
 * QA metrics: 3 维度
 */
export function convertQAMetrics(result: SwissCheeseResult): EvaluationMetric[] {
  return [
    {
      dimension: EvaluationDimension.ANSWER_CORRECTNESS,
      score: result.aggregatedMetrics.answerCorrectness?.score ?? 70,
      weight: 0.60,
      details: {
        reason: result.aggregatedMetrics.answerCorrectness?.reasons?.join('; ') || 'QA 评审员评估',
      },
      suggestions: result.suggestions,
    },
    {
      dimension: EvaluationDimension.REASONING_QUALITY,
      score: result.aggregatedMetrics.reasoningQuality?.score ?? 70,
      weight: 0.25,
      details: {
        reason: result.aggregatedMetrics.reasoningQuality?.reasons?.join('; ') || 'QA 评审员评估',
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.COMMUNICATION_QUALITY,
      score: result.aggregatedMetrics.communicationQuality?.score ?? 70,
      weight: 0.15,
      details: {
        reason: result.aggregatedMetrics.communicationQuality?.reasons?.join('; ') || 'QA 评审员评估',
      },
      suggestions: [],
    },
  ];
}

/**
 * Research metrics: 3 维度
 */
export function convertResearchMetrics(result: SwissCheeseResult): EvaluationMetric[] {
  return [
    {
      dimension: EvaluationDimension.OUTCOME_VERIFICATION,
      score: result.aggregatedMetrics.outcomeVerification?.score ?? 70,
      weight: 0.40,
      details: {
        reason: result.aggregatedMetrics.outcomeVerification?.reasons?.join('; ') || '研究任务分析师评估',
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.INFORMATION_QUALITY,
      score: result.aggregatedMetrics.informationQuality?.score ?? 70,
      weight: 0.35,
      details: {
        reason: result.aggregatedMetrics.informationQuality?.reasons?.join('; ') || '信息质量评审员评估',
      },
      suggestions: result.suggestions,
    },
    {
      dimension: EvaluationDimension.COMMUNICATION_QUALITY,
      score: result.aggregatedMetrics.communicationQuality?.score ?? 70,
      weight: 0.25,
      details: {
        reason: result.aggregatedMetrics.communicationQuality?.reasons?.join('; ') || '综合评估',
      },
      suggestions: [],
    },
  ];
}

/**
 * Creation metrics: 3 维度
 */
export function convertCreationMetrics(result: SwissCheeseResult): EvaluationMetric[] {
  return [
    {
      dimension: EvaluationDimension.OUTCOME_VERIFICATION,
      score: result.aggregatedMetrics.outcomeVerification?.score ?? 70,
      weight: 0.45,
      details: {
        reason: result.aggregatedMetrics.outcomeVerification?.reasons?.join('; ') || '创作任务分析师评估',
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.OUTPUT_QUALITY,
      score: result.aggregatedMetrics.outputQuality?.score ?? 70,
      weight: 0.35,
      details: {
        reason: result.aggregatedMetrics.outputQuality?.reasons?.join('; ') || '产出质量评审员评估',
      },
      suggestions: result.suggestions,
    },
    {
      dimension: EvaluationDimension.REQUIREMENT_COMPLIANCE,
      score: result.aggregatedMetrics.requirementCompliance?.score ?? 70,
      weight: 0.20,
      details: {
        reason: result.aggregatedMetrics.requirementCompliance?.reasons?.join('; ') || '综合评估',
      },
      suggestions: [],
    },
  ];
}

/**
 * Coding metrics: 7 维度 + 1 信息维度（原有逻辑）
 */
export function convertCodingMetrics(result: SwissCheeseResult): EvaluationMetric[] {
  return [
    {
      dimension: EvaluationDimension.OUTCOME_VERIFICATION,
      score: result.aggregatedMetrics.outcomeVerification?.score ?? 70,
      weight: 0.35,
      details: {
        reason: result.aggregatedMetrics.outcomeVerification?.reasons?.join('; ') || '多评审员综合评估',
        reviewers: result.reviewerResults.map((r) => ({
          name: r.reviewerName,
          score: r.scores.outcomeVerification,
        })),
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.CODE_QUALITY,
      score: result.aggregatedMetrics.codeQuality?.score ?? 70,
      weight: 0.20,
      details: {
        reason: result.aggregatedMetrics.codeQuality?.reasons?.join('; ') || '多评审员综合评估',
        codeVerification: result.codeVerification,
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.SECURITY,
      score: result.aggregatedMetrics.security?.score ?? 70,
      weight: 0.15,
      details: {
        reason: result.aggregatedMetrics.security?.reasons?.join('; ') || '多评审员综合评估',
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.TOOL_EFFICIENCY,
      score: result.aggregatedMetrics.toolEfficiency?.score ?? 70,
      weight: 0.08,
      details: {
        reason: result.aggregatedMetrics.toolEfficiency?.reasons?.join('; ') || '多评审员综合评估',
      },
      suggestions: [],
    },
    // 代码 Grader 维度
    {
      dimension: EvaluationDimension.SELF_REPAIR,
      score: result.aggregatedMetrics.selfRepair?.score ?? 80,
      weight: 0.05,
      details: {
        reason: result.aggregatedMetrics.selfRepair?.reasons?.join('; ') || '',
        ...result.transcriptMetrics.selfRepair,
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.VERIFICATION_QUALITY,
      score: result.aggregatedMetrics.verificationQuality?.score ?? 80,
      weight: 0.04,
      details: {
        reason: result.aggregatedMetrics.verificationQuality?.reasons?.join('; ') || '',
        ...result.transcriptMetrics.verificationQuality,
      },
      suggestions: [],
    },
    {
      dimension: EvaluationDimension.FORBIDDEN_PATTERNS,
      score: result.aggregatedMetrics.forbiddenPatterns?.score ?? 100,
      weight: 0.03,
      details: {
        reason: result.aggregatedMetrics.forbiddenPatterns?.reasons?.join('; ') || '',
        ...result.transcriptMetrics.forbiddenPatterns,
      },
      suggestions: [],
    },
    // 信息维度（不计分）
    {
      dimension: EvaluationDimension.ERROR_TAXONOMY,
      score: 0,
      weight: 0,
      informational: true,
      details: {
        reason: '错误分类统计',
        taxonomy: result.transcriptMetrics.errorTaxonomy,
      },
      suggestions: [],
    },
  ];
}
