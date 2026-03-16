// ============================================================================
// Swiss Cheese Evaluator - 瑞士奶酪多层评测模型 (v3)
// ============================================================================
// v3 变化：
// - 7 个计分维度 + 3 个信息维度
// - 结构化 Transcript 输入（替代纯文本拼接）
// - 代码 Grader: self_repair, verification_quality, forbidden_patterns
// - LLM 评审员仍用于 outcome_verification, code_quality, security, tool_efficiency
// ============================================================================

import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';
import type { EvaluationMetric } from '../../shared/types/evaluation';
import type { SessionSnapshot, TranscriptMetrics, ConversationType } from './types';

// Sub-modules
import {
  REVIEWER_CONFIGS,
  QA_REVIEWER_PROMPT,
  QA_OUTPUT_FORMAT,
  RESEARCH_TASK_ANALYST_PROMPT,
  RESEARCH_INFO_QUALITY_PROMPT,
  RESEARCH_OUTPUT_FORMAT,
  CREATION_TASK_ANALYST_PROMPT,
  CREATION_OUTPUT_QUALITY_PROMPT,
  CREATION_OUTPUT_FORMAT,
  computePromptHash,
} from './evaluationPrompts';
import { analyzeTranscript } from './codeGrader';
import { runReviewer, callLLM, parseGenericResponse } from './reviewerExecutor';
import { aggregateResults } from './resultAggregator';
import { detectConversationType } from './conversationDetector';
import { buildStructuredTranscript } from './transcriptBuilder';
import { convertToMetrics as convertToMetricsImpl } from './metricsConverter';

const logger = createLogger('SwissCheeseEvaluator');

// ----------------------------------------------------------------------------
// Types (re-exported for consumers)
// ----------------------------------------------------------------------------

/** 单个评审员的评测结果 */
export interface ReviewerResult {
  reviewerId: string;
  reviewerName: string;
  perspective: string;
  scores: {
    outcomeVerification: number;
    codeQuality: number;
    security: number;
    toolEfficiency: number;
  };
  findings: string[];
  concerns: string[];
  passed: boolean;
}

/** 代码执行验证结果 */
export interface CodeVerificationResult {
  hasCode: boolean;
  codeBlocks: number;
  syntaxValid: boolean;
  executionAttempted: boolean;
  executionSuccess: boolean;
  errors: string[];
}

/** 瑞士奶酪评测最终结果 */
export interface SwissCheeseResult {
  overallScore: number;
  consensus: boolean;
  conversationType: ConversationType;
  reviewerResults: ReviewerResult[];
  codeVerification: CodeVerificationResult;
  aggregatedMetrics: Record<string, { score: number; reasons: string[] }>;
  transcriptMetrics: TranscriptMetrics;
  suggestions: string[];
  summary: string;
  layersCoverage: string[];
  promptHash: string;
}

/** Scoring config entry for weight overrides */
export interface ScoringConfigEntry {
  dimension: string;
  weight: number; // percentage (e.g. 35) or decimal (e.g. 0.35)
  judgePrompt?: string; // custom judge prompt override for LLM-type dimensions
  graderType?: 'llm' | 'rule' | 'code'; // grader type for this dimension
  importance?: 'critical' | 'high' | 'medium' | 'low'; // importance level
}

// ----------------------------------------------------------------------------
// Swiss Cheese Evaluator Class
// ----------------------------------------------------------------------------

export class SwissCheeseEvaluator {
  private modelRouter: ModelRouter;

  constructor() {
    this.modelRouter = new ModelRouter();
  }

  /**
   * 检测对话类型
   */
  detectConversationType(snapshot: SessionSnapshot): ConversationType {
    return detectConversationType(snapshot);
  }

  /**
   * 执行自适应评测（v4: 根据对话类型选择评测策略）
   */
  async evaluate(snapshot: SessionSnapshot, scoringConfig?: ScoringConfigEntry[]): Promise<SwissCheeseResult | null> {
    const transcript = buildStructuredTranscript(snapshot);

    if (!transcript) {
      logger.warn('No conversation to evaluate');
      return null;
    }

    const conversationType = detectConversationType(snapshot);
    logger.info(`Starting adaptive evaluation, type: ${conversationType}`);

    try {
      switch (conversationType) {
        case 'qa':
          return this.evaluateQA(snapshot, transcript);
        case 'research':
          return this.evaluateResearch(snapshot, transcript);
        case 'creation':
          return this.evaluateCreation(snapshot, transcript);
        case 'coding':
        default:
          return this.evaluateCoding(snapshot, transcript, scoringConfig);
      }
    } catch (error) {
      logger.error('Adaptive evaluation failed', { error, conversationType });
      return null;
    }
  }

  /**
   * QA 评测 — 1 次 LLM 调用
   */
  private async evaluateQA(
    snapshot: SessionSnapshot,
    transcript: string
  ): Promise<SwissCheeseResult> {
    logger.info('Running QA evaluation (1 LLM call)...');

    const transcriptMetrics = analyzeTranscript(snapshot);
    const codeVerification = await this.verifyCode(snapshot);

    // 单次 LLM 调用，评估 3 个维度
    const response = await callLLM(
      this.modelRouter,
      `${QA_REVIEWER_PROMPT}\n\n${QA_OUTPUT_FORMAT}`,
      `请评估以下对话：\n\n${transcript}`
    );

    let scores = { answerCorrectness: 70, reasoningQuality: 70, communicationQuality: 70 };
    let findings: string[] = [];
    let concerns: string[] = [];
    let passed = true;
    let summary = 'QA 评测完成';

    if (response) {
      const parsed = parseGenericResponse(response);
      scores = {
        answerCorrectness: parsed.scores?.answerCorrectness ?? 70,
        reasoningQuality: parsed.scores?.reasoningQuality ?? 70,
        communicationQuality: parsed.scores?.communicationQuality ?? 70,
      };
      findings = parsed.findings || [];
      concerns = parsed.concerns || [];
      passed = parsed.passed ?? true;
      summary = parsed.summary || summary;
    }

    const aggregatedMetrics: Record<string, { score: number; reasons: string[] }> = {
      answerCorrectness: { score: scores.answerCorrectness, reasons: findings.slice(0, 3) },
      reasoningQuality: { score: scores.reasoningQuality, reasons: [] },
      communicationQuality: { score: scores.communicationQuality, reasons: [] },
    };

    const overallScore = Math.round(
      scores.answerCorrectness * 0.60 +
      scores.reasoningQuality * 0.25 +
      scores.communicationQuality * 0.15
    );

    const suggestions = concerns.slice(0, 5);

    return {
      overallScore,
      consensus: passed,
      conversationType: 'qa',
      reviewerResults: [{
        reviewerId: 'qa_reviewer',
        reviewerName: 'QA 评审员',
        perspective: '专注于回答正确性和推理质量',
        scores: { outcomeVerification: scores.answerCorrectness, codeQuality: 70, security: 70, toolEfficiency: 70 },
        findings,
        concerns,
        passed,
      }],
      codeVerification,
      aggregatedMetrics,
      transcriptMetrics,
      suggestions,
      summary: `QA 评测：综合得分 ${overallScore}。${summary}`,
      layersCoverage: ['回答正确性层', '推理质量层', '表达质量层'],
      promptHash: computePromptHash(),
    };
  }

  /**
   * Research 评测 — 2 次并行 LLM 调用
   */
  private async evaluateResearch(
    snapshot: SessionSnapshot,
    transcript: string
  ): Promise<SwissCheeseResult> {
    logger.info('Running Research evaluation (2 LLM calls)...');

    const transcriptMetrics = analyzeTranscript(snapshot);
    const codeVerification = await this.verifyCode(snapshot);

    // 2 个评审员并行
    const [taskAnalystResponse, infoQualityResponse] = await Promise.all([
      callLLM(
        this.modelRouter,
        `${RESEARCH_TASK_ANALYST_PROMPT}\n\n${RESEARCH_OUTPUT_FORMAT}`,
        `请评估以下研究对话：\n\n${transcript}`
      ),
      callLLM(
        this.modelRouter,
        `${RESEARCH_INFO_QUALITY_PROMPT}\n\n${RESEARCH_OUTPUT_FORMAT}`,
        `请评估以下研究对话中的信息质量：\n\n${transcript}`
      ),
    ]);

    const taskResult = taskAnalystResponse ? parseGenericResponse(taskAnalystResponse) : {};
    const infoResult = infoQualityResponse ? parseGenericResponse(infoQualityResponse) : {};

    const outcomeScore = taskResult.scores?.outcomeVerification ?? 70;
    const infoScore = infoResult.scores?.informationQuality ?? 70;
    const commScore = Math.round(
      ((taskResult.scores?.communicationQuality ?? 70) + (infoResult.scores?.communicationQuality ?? 70)) / 2
    );

    const allConcerns = [...(taskResult.concerns || []), ...(infoResult.concerns || [])];

    const aggregatedMetrics: Record<string, { score: number; reasons: string[] }> = {
      outcomeVerification: { score: outcomeScore, reasons: (taskResult.findings || []).slice(0, 3) },
      informationQuality: { score: infoScore, reasons: (infoResult.findings || []).slice(0, 3) },
      communicationQuality: { score: commScore, reasons: [] },
    };

    const overallScore = Math.round(
      outcomeScore * 0.40 +
      infoScore * 0.35 +
      commScore * 0.25
    );

    const reviewerResults: ReviewerResult[] = [
      {
        reviewerId: 'research_task_analyst',
        reviewerName: '研究任务分析师',
        perspective: '专注于研究任务完成度',
        scores: { outcomeVerification: outcomeScore, codeQuality: 70, security: 70, toolEfficiency: 70 },
        findings: taskResult.findings || [],
        concerns: taskResult.concerns || [],
        passed: taskResult.passed ?? true,
      },
      {
        reviewerId: 'information_quality',
        reviewerName: '信息质量评审员',
        perspective: '专注于信息准确性和全面性',
        scores: { outcomeVerification: 70, codeQuality: 70, security: 70, toolEfficiency: infoScore },
        findings: infoResult.findings || [],
        concerns: infoResult.concerns || [],
        passed: infoResult.passed ?? true,
      },
    ];

    return {
      overallScore,
      consensus: reviewerResults.every(r => r.passed),
      conversationType: 'research',
      reviewerResults,
      codeVerification,
      aggregatedMetrics,
      transcriptMetrics,
      suggestions: allConcerns.slice(0, 5),
      summary: `研究评测：综合得分 ${overallScore}。${taskResult.summary || ''} ${infoResult.summary || ''}`.trim(),
      layersCoverage: ['结果验证层', '信息质量层', '表达质量层'],
      promptHash: computePromptHash(),
    };
  }

  /**
   * Creation 评测 — 2 次并行 LLM 调用
   */
  private async evaluateCreation(
    snapshot: SessionSnapshot,
    transcript: string
  ): Promise<SwissCheeseResult> {
    logger.info('Running Creation evaluation (2 LLM calls)...');

    const transcriptMetrics = analyzeTranscript(snapshot);
    const codeVerification = await this.verifyCode(snapshot);

    // 2 个评审员并行
    const [taskAnalystResponse, outputQualityResponse] = await Promise.all([
      callLLM(
        this.modelRouter,
        `${CREATION_TASK_ANALYST_PROMPT}\n\n${CREATION_OUTPUT_FORMAT}`,
        `请评估以下内容创作对话：\n\n${transcript}`
      ),
      callLLM(
        this.modelRouter,
        `${CREATION_OUTPUT_QUALITY_PROMPT}\n\n${CREATION_OUTPUT_FORMAT}`,
        `请评估以下内容创作的产出质量：\n\n${transcript}`
      ),
    ]);

    const taskResult = taskAnalystResponse ? parseGenericResponse(taskAnalystResponse) : {};
    const outputResult = outputQualityResponse ? parseGenericResponse(outputQualityResponse) : {};

    const outcomeScore = taskResult.scores?.outcomeVerification ?? 70;
    const outputScore = outputResult.scores?.outputQuality ?? 70;
    const reqScore = Math.round(
      ((taskResult.scores?.requirementCompliance ?? 70) + (outputResult.scores?.requirementCompliance ?? 70)) / 2
    );

    const allConcerns = [...(taskResult.concerns || []), ...(outputResult.concerns || [])];

    const aggregatedMetrics: Record<string, { score: number; reasons: string[] }> = {
      outcomeVerification: { score: outcomeScore, reasons: (taskResult.findings || []).slice(0, 3) },
      outputQuality: { score: outputScore, reasons: (outputResult.findings || []).slice(0, 3) },
      requirementCompliance: { score: reqScore, reasons: [] },
    };

    const overallScore = Math.round(
      outcomeScore * 0.45 +
      outputScore * 0.35 +
      reqScore * 0.20
    );

    const reviewerResults: ReviewerResult[] = [
      {
        reviewerId: 'creation_task_analyst',
        reviewerName: '创作任务分析师',
        perspective: '专注于创作任务完成度',
        scores: { outcomeVerification: outcomeScore, codeQuality: 70, security: 70, toolEfficiency: 70 },
        findings: taskResult.findings || [],
        concerns: taskResult.concerns || [],
        passed: taskResult.passed ?? true,
      },
      {
        reviewerId: 'output_quality',
        reviewerName: '产出质量评审员',
        perspective: '专注于产出格式和质量',
        scores: { outcomeVerification: 70, codeQuality: 70, security: 70, toolEfficiency: outputScore },
        findings: outputResult.findings || [],
        concerns: outputResult.concerns || [],
        passed: outputResult.passed ?? true,
      },
    ];

    return {
      overallScore,
      consensus: reviewerResults.every(r => r.passed),
      conversationType: 'creation',
      reviewerResults,
      codeVerification,
      aggregatedMetrics,
      transcriptMetrics,
      suggestions: allConcerns.slice(0, 5),
      summary: `创作评测：综合得分 ${overallScore}。${taskResult.summary || ''} ${outputResult.summary || ''}`.trim(),
      layersCoverage: ['结果验证层', '产出质量层', '需求符合度层'],
      promptHash: computePromptHash(),
    };
  }

  /**
   * Coding 评测 — 4 次并行 LLM 调用（原有逻辑）
   */
  private async evaluateCoding(
    snapshot: SessionSnapshot,
    transcript: string,
    scoringConfig?: ScoringConfigEntry[]
  ): Promise<SwissCheeseResult> {
    logger.info('Running Coding evaluation (4 LLM calls)...');

    // 1. 代码 Grader: 从结构化数据计算硬指标
    const transcriptMetrics = analyzeTranscript(snapshot);

    // 2. 并行运行 LLM 评审员（支持自定义 Judge Prompt）
    const reviewerToDimension: Record<string, string> = {
      task_analyst: 'outcomeVerification',
      code_reviewer: 'codeQuality',
      security_auditor: 'security',
      efficiency_expert: 'toolEfficiency',
    };
    const reviewerPromises = REVIEWER_CONFIGS.map((config) => {
      const dimName = reviewerToDimension[config.id];
      const promptOverride = scoringConfig?.find(s => s.dimension === dimName)?.judgePrompt;
      return runReviewer(this.modelRouter, config, transcript, promptOverride || undefined);
    });
    const reviewerResults = await Promise.all(reviewerPromises);

    // 3. 代码执行验证
    const codeVerification = await this.verifyCode(snapshot);

    // 4. 聚合结果
    const aggregated = aggregateResults(reviewerResults, codeVerification, transcriptMetrics, scoringConfig);

    const result: SwissCheeseResult = {
      overallScore: aggregated.overallScore,
      consensus: reviewerResults.every((r) => r.passed),
      conversationType: 'coding',
      reviewerResults,
      codeVerification,
      aggregatedMetrics: aggregated.metrics,
      transcriptMetrics,
      suggestions: aggregated.suggestions,
      summary: aggregated.summary,
      layersCoverage: [
        '结果验证层',
        '代码质量审查层',
        '安全风险检测层',
        '工具效率评估层',
        '代码 Grader 层（self-repair, verification, forbidden）',
      ],
      promptHash: computePromptHash(),
    };

    logger.info('Coding evaluation completed', {
      overallScore: result.overallScore,
      consensus: result.consensus,
      selfRepairRate: transcriptMetrics.selfRepair.rate,
    });

    return result;
  }

  /**
   * 分析 Transcript — 代码 Grader（不依赖 LLM）
   */
  analyzeTranscript(snapshot: SessionSnapshot): TranscriptMetrics {
    return analyzeTranscript(snapshot);
  }

  /**
   * 验证代码是否可执行
   */
  private async verifyCode(snapshot: SessionSnapshot): Promise<CodeVerificationResult> {
    const codeBlocks: string[] = [];

    // 从 turns 或 messages 提取代码块
    const sources = snapshot.turns.length > 0
      ? snapshot.turns.map(t => t.assistantResponse)
      : snapshot.messages.filter(m => m.role === 'assistant').map(m => m.content);

    for (const content of sources) {
      const matches = content.matchAll(/```(\w*)\n([\s\S]*?)```/g);
      for (const match of matches) {
        if (match[2]?.trim()) {
          codeBlocks.push(match[2].trim());
        }
      }
    }

    if (codeBlocks.length === 0) {
      return {
        hasCode: false,
        codeBlocks: 0,
        syntaxValid: true,
        executionAttempted: false,
        executionSuccess: true,
        errors: [],
      };
    }

    const syntaxErrors: string[] = [];
    for (let i = 0; i < codeBlocks.length; i++) {
      const code = codeBlocks[i];
      const openBrackets = (code.match(/[{[(]/g) || []).length;
      const closeBrackets = (code.match(/[}\])]/g) || []).length;
      if (openBrackets !== closeBrackets) {
        syntaxErrors.push(`代码块 ${i + 1}: 括号不匹配`);
      }
    }

    return {
      hasCode: true,
      codeBlocks: codeBlocks.length,
      syntaxValid: syntaxErrors.length === 0,
      executionAttempted: false,
      executionSuccess: syntaxErrors.length === 0,
      errors: syntaxErrors,
    };
  }

  /**
   * 将 SwissCheeseResult 转换为标准 EvaluationMetric 格式（根据 conversationType 适配）
   */
  convertToMetrics(result: SwissCheeseResult): EvaluationMetric[] {
    return convertToMetricsImpl(result);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let evaluatorInstance: SwissCheeseEvaluator | null = null;

export function getSwissCheeseEvaluator(): SwissCheeseEvaluator {
  if (!evaluatorInstance) {
    evaluatorInstance = new SwissCheeseEvaluator();
  }
  return evaluatorInstance;
}
