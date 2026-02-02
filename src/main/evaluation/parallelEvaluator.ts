// ============================================================================
// Parallel Evaluator - 多 Agent 并行评估服务
// ============================================================================
// 从多个候选方案中选择最优结果
// 支持三种策略：best（单评审）、vote（多评审投票）、weighted（加权评分）
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { compactModelSummarize } from '../context/compactModel';
import type {
  TaskOutput,
  EvaluateTaskConfig,
  EvaluationDimension,
  EvaluateSelectionStrategy,
  EvaluationResult,
} from '../../shared/types/taskDAG';

const logger = createLogger('ParallelEvaluator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CandidateOutput {
  taskId: string;
  output: TaskOutput;
}

export interface EvaluationConfig {
  dimensions: EvaluationDimension[];
  customPrompt?: string;
}

interface DimensionScore {
  taskId: string;
  dimension: EvaluationDimension;
  score: number;
  reasoning: string;
}

// ----------------------------------------------------------------------------
// Dimension Weights
// ----------------------------------------------------------------------------

const DEFAULT_DIMENSION_WEIGHTS: Record<EvaluationDimension, number> = {
  correctness: 0.25,
  efficiency: 0.15,
  readability: 0.15,
  maintainability: 0.15,
  security: 0.10,
  performance: 0.10,
  coverage: 0.05,
  simplicity: 0.05,
};

const DIMENSION_PROMPTS: Record<EvaluationDimension, string> = {
  correctness: '代码是否正确实现了需求？是否有逻辑错误？',
  efficiency: '实现是否高效？是否有不必要的计算或资源浪费？',
  readability: '代码是否易于阅读和理解？命名是否清晰？',
  maintainability: '代码是否易于维护和扩展？是否遵循设计原则？',
  security: '是否存在安全漏洞？是否正确处理了敏感数据？',
  performance: '性能是否良好？是否有优化空间？',
  coverage: '是否覆盖了所有边界情况和错误处理？',
  simplicity: '实现是否简洁？是否避免了过度设计？',
};

// ----------------------------------------------------------------------------
// Parallel Evaluator
// ----------------------------------------------------------------------------

export class ParallelEvaluator {
  /**
   * 评估候选方案并选择最优
   */
  async evaluate(
    candidates: CandidateOutput[],
    config: EvaluateTaskConfig
  ): Promise<EvaluationResult> {
    const startTime = Date.now();

    if (candidates.length === 0) {
      throw new Error('No candidates to evaluate');
    }

    if (candidates.length === 1) {
      // 只有一个候选，直接返回
      return {
        winnerId: candidates[0].taskId,
        scores: [{
          taskId: candidates[0].taskId,
          score: 100,
          breakdown: this.createFullScoreBreakdown(config.dimensions),
          reasoning: 'Only one candidate',
        }],
        duration: Date.now() - startTime,
      };
    }

    logger.info(`Evaluating ${candidates.length} candidates using ${config.selectionStrategy} strategy`);

    let result: EvaluationResult;

    switch (config.selectionStrategy) {
      case 'best':
        result = await this.selectBest(candidates, config);
        break;
      case 'vote':
        result = await this.voteSelect(candidates, config);
        break;
      case 'weighted':
        result = await this.weightedSelect(candidates, config);
        break;
      default:
        result = await this.selectBest(candidates, config);
    }

    result.duration = Date.now() - startTime;

    logger.info(`Evaluation complete: winner=${result.winnerId}, duration=${result.duration}ms`);

    return result;
  }

  /**
   * 单评审员选择最优
   */
  async selectBest(
    candidates: CandidateOutput[],
    config: EvaluateTaskConfig
  ): Promise<EvaluationResult> {
    const prompt = this.buildComparisonPrompt(candidates, config);
    const response = await this.callEvaluator(prompt);
    return this.parseEvaluationResponse(response, candidates, config.dimensions);
  }

  /**
   * 多评审员投票选择
   */
  async voteSelect(
    candidates: CandidateOutput[],
    config: EvaluateTaskConfig
  ): Promise<EvaluationResult> {
    // 针对每个维度进行单独评估
    const dimensionResults: Map<string, number> = new Map();
    const allScores: Map<string, DimensionScore[]> = new Map();

    // 初始化
    for (const candidate of candidates) {
      dimensionResults.set(candidate.taskId, 0);
      allScores.set(candidate.taskId, []);
    }

    // 对每个维度进行投票
    for (const dimension of config.dimensions) {
      const prompt = this.buildDimensionPrompt(candidates, dimension, config.customPrompt);
      const response = await this.callEvaluator(prompt);
      const winnerId = this.parseDimensionWinner(response, candidates);

      if (winnerId) {
        const currentVotes = dimensionResults.get(winnerId) || 0;
        dimensionResults.set(winnerId, currentVotes + 1);
      }

      // 记录每个候选的维度得分
      const scores = this.parseDimensionScores(response, candidates, dimension);
      for (const score of scores) {
        const existing = allScores.get(score.taskId) || [];
        existing.push(score);
        allScores.set(score.taskId, existing);
      }
    }

    // 找出得票最多的候选
    let winnerId = candidates[0].taskId;
    let maxVotes = 0;
    for (const [taskId, votes] of dimensionResults.entries()) {
      if (votes > maxVotes) {
        maxVotes = votes;
        winnerId = taskId;
      }
    }

    // 构建结果
    const scores = candidates.map(candidate => {
      const dimensionScores = allScores.get(candidate.taskId) || [];
      const totalScore = this.calculateTotalScore(dimensionScores);
      return {
        taskId: candidate.taskId,
        score: totalScore,
        breakdown: this.buildBreakdown(dimensionScores),
        reasoning: `Received ${dimensionResults.get(candidate.taskId) || 0} votes out of ${config.dimensions.length}`,
      };
    });

    return {
      winnerId,
      scores,
      duration: 0,
    };
  }

  /**
   * 加权评分选择
   */
  async weightedSelect(
    candidates: CandidateOutput[],
    config: EvaluateTaskConfig
  ): Promise<EvaluationResult> {
    const allScores: Map<string, DimensionScore[]> = new Map();

    // 初始化
    for (const candidate of candidates) {
      allScores.set(candidate.taskId, []);
    }

    // 对每个维度评分
    for (const dimension of config.dimensions) {
      const prompt = this.buildScoringPrompt(candidates, dimension, config.customPrompt);
      const response = await this.callEvaluator(prompt);
      const scores = this.parseDimensionScores(response, candidates, dimension);

      for (const score of scores) {
        const existing = allScores.get(score.taskId) || [];
        existing.push(score);
        allScores.set(score.taskId, existing);
      }
    }

    // 计算加权总分
    const scores = candidates.map(candidate => {
      const dimensionScores = allScores.get(candidate.taskId) || [];
      const totalScore = this.calculateWeightedScore(dimensionScores);
      return {
        taskId: candidate.taskId,
        score: totalScore,
        breakdown: this.buildBreakdown(dimensionScores),
        reasoning: this.buildReasoningSummary(dimensionScores),
      };
    });

    // 找出最高分
    scores.sort((a, b) => b.score - a.score);
    const winnerId = scores[0].taskId;

    return {
      winnerId,
      scores,
      duration: 0,
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private buildComparisonPrompt(
    candidates: CandidateOutput[],
    config: EvaluateTaskConfig
  ): string {
    const candidateTexts = candidates.map((c, i) =>
      `## 候选方案 ${i + 1} (ID: ${c.taskId})\n${c.output.text}`
    ).join('\n\n');

    const dimensionList = config.dimensions.map(d =>
      `- ${d}: ${DIMENSION_PROMPTS[d]}`
    ).join('\n');

    return `请比较以下候选方案，并选择最优的一个。

${config.customPrompt || ''}

评估维度：
${dimensionList}

${candidateTexts}

请按以下 JSON 格式输出评估结果：
{
  "winnerId": "获胜候选的 ID",
  "scores": [
    {
      "taskId": "候选 ID",
      "score": 0-100 的总分,
      "breakdown": { "维度名": 分数, ... },
      "reasoning": "评分理由"
    }
  ]
}`;
  }

  private buildDimensionPrompt(
    candidates: CandidateOutput[],
    dimension: EvaluationDimension,
    customPrompt?: string
  ): string {
    const candidateTexts = candidates.map((c, i) =>
      `## 候选 ${i + 1} (ID: ${c.taskId})\n${c.output.text.substring(0, 2000)}`
    ).join('\n\n');

    return `请从 "${dimension}" 维度评估以下候选方案。

${customPrompt || ''}

评估标准：${DIMENSION_PROMPTS[dimension]}

${candidateTexts}

请输出：
1. 每个候选的 ${dimension} 得分（0-100）
2. 该维度的获胜者 ID

格式：
SCORES: 候选ID:分数, 候选ID:分数, ...
WINNER: 获胜候选ID`;
  }

  private buildScoringPrompt(
    candidates: CandidateOutput[],
    dimension: EvaluationDimension,
    customPrompt?: string
  ): string {
    const candidateTexts = candidates.map((c, i) =>
      `## 候选 ${i + 1} (ID: ${c.taskId})\n${c.output.text.substring(0, 2000)}`
    ).join('\n\n');

    return `请为以下候选方案的 "${dimension}" 维度打分（0-100）。

${customPrompt || ''}

评估标准：${DIMENSION_PROMPTS[dimension]}

${candidateTexts}

请为每个候选打分，格式：
候选ID: 分数 - 理由
...`;
  }

  private async callEvaluator(prompt: string): Promise<string> {
    try {
      return await compactModelSummarize(prompt, 1000);
    } catch (error) {
      logger.error('Evaluator call failed', { error });
      throw error;
    }
  }

  private parseEvaluationResponse(
    response: string,
    candidates: CandidateOutput[],
    dimensions: EvaluationDimension[]
  ): EvaluationResult {
    try {
      // 尝试解析 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          winnerId: parsed.winnerId || candidates[0].taskId,
          scores: parsed.scores || candidates.map(c => ({
            taskId: c.taskId,
            score: 50,
            breakdown: this.createEmptyBreakdown(dimensions),
            reasoning: 'Could not parse detailed scores',
          })),
          duration: 0,
        };
      }
    } catch (e) {
      logger.warn('Failed to parse evaluation response as JSON', { error: e });
    }

    // 回退：尝试从文本中提取获胜者
    const winnerMatch = response.match(/(?:winner|获胜|最优)[:\s]*([^\s,]+)/i);
    const winnerId = winnerMatch
      ? candidates.find(c => response.includes(c.taskId))?.taskId || candidates[0].taskId
      : candidates[0].taskId;

    return {
      winnerId,
      scores: candidates.map(c => ({
        taskId: c.taskId,
        score: c.taskId === winnerId ? 80 : 60,
        breakdown: this.createEmptyBreakdown(dimensions),
        reasoning: 'Extracted from text response',
      })),
      duration: 0,
    };
  }

  private parseDimensionWinner(
    response: string,
    candidates: CandidateOutput[]
  ): string | null {
    const winnerMatch = response.match(/WINNER:\s*(\S+)/);
    if (winnerMatch) {
      const winnerId = winnerMatch[1];
      if (candidates.some(c => c.taskId === winnerId)) {
        return winnerId;
      }
    }
    return null;
  }

  private parseDimensionScores(
    response: string,
    candidates: CandidateOutput[],
    dimension: EvaluationDimension
  ): DimensionScore[] {
    const scores: DimensionScore[] = [];

    for (const candidate of candidates) {
      const regex = new RegExp(`${candidate.taskId}[:\\s]*(\\d+)`, 'i');
      const match = response.match(regex);
      const score = match ? parseInt(match[1], 10) : 50;

      scores.push({
        taskId: candidate.taskId,
        dimension,
        score: Math.min(100, Math.max(0, score)),
        reasoning: '',
      });
    }

    return scores;
  }

  private calculateTotalScore(scores: DimensionScore[]): number {
    if (scores.length === 0) return 0;
    const sum = scores.reduce((acc, s) => acc + s.score, 0);
    return Math.round(sum / scores.length);
  }

  private calculateWeightedScore(scores: DimensionScore[]): number {
    if (scores.length === 0) return 0;

    let totalWeight = 0;
    let weightedSum = 0;

    for (const score of scores) {
      const weight = DEFAULT_DIMENSION_WEIGHTS[score.dimension] || 0.1;
      weightedSum += score.score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  }

  private buildBreakdown(scores: DimensionScore[]): Record<EvaluationDimension, number> {
    const breakdown: Partial<Record<EvaluationDimension, number>> = {};
    for (const score of scores) {
      breakdown[score.dimension] = score.score;
    }
    return breakdown as Record<EvaluationDimension, number>;
  }

  private buildReasoningSummary(scores: DimensionScore[]): string {
    const parts = scores
      .filter(s => s.reasoning)
      .map(s => `${s.dimension}: ${s.reasoning}`)
      .slice(0, 3);
    return parts.join('; ') || 'Evaluated across multiple dimensions';
  }

  private createEmptyBreakdown(dimensions: EvaluationDimension[]): Record<EvaluationDimension, number> {
    const breakdown: Partial<Record<EvaluationDimension, number>> = {};
    for (const d of dimensions) {
      breakdown[d] = 0;
    }
    return breakdown as Record<EvaluationDimension, number>;
  }

  private createFullScoreBreakdown(dimensions: EvaluationDimension[]): Record<EvaluationDimension, number> {
    const breakdown: Partial<Record<EvaluationDimension, number>> = {};
    for (const d of dimensions) {
      breakdown[d] = 100;
    }
    return breakdown as Record<EvaluationDimension, number>;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let parallelEvaluatorInstance: ParallelEvaluator | null = null;

export function getParallelEvaluator(): ParallelEvaluator {
  if (!parallelEvaluatorInstance) {
    parallelEvaluatorInstance = new ParallelEvaluator();
  }
  return parallelEvaluatorInstance;
}
