// ============================================================================
// Result Aggregator - 聚合多个评审员的结果 + 代码 Grader
// ============================================================================

import type { TranscriptMetrics } from './types';
import type { SwissCheeseResult, ReviewerResult, CodeVerificationResult, ScoringConfigEntry } from './swissCheeseEvaluator';

/**
 * 聚合多个评审员的结果 + 代码 Grader (v3)
 */
export function aggregateResults(
  reviewerResults: ReviewerResult[],
  codeVerification: CodeVerificationResult,
  transcriptMetrics: TranscriptMetrics,
  scoringConfig?: ScoringConfigEntry[]
): {
  overallScore: number;
  metrics: SwissCheeseResult['aggregatedMetrics'];
  suggestions: string[];
  summary: string;
} {
  // 收集 LLM 评审员分数
  const allScores = {
    outcomeVerification: [] as number[],
    codeQuality: [] as number[],
    security: [] as number[],
    toolEfficiency: [] as number[],
  };

  const allReasons = {
    outcomeVerification: [] as string[],
    codeQuality: [] as string[],
    security: [] as string[],
    toolEfficiency: [] as string[],
  };

  for (const result of reviewerResults) {
    allScores.outcomeVerification.push(result.scores.outcomeVerification);
    allScores.codeQuality.push(result.scores.codeQuality);
    allScores.security.push(result.scores.security);
    allScores.toolEfficiency.push(result.scores.toolEfficiency);

    for (const finding of result.findings) {
      if (finding.includes('任务') || finding.includes('完成') || finding.includes('验证')) {
        allReasons.outcomeVerification.push(`[${result.reviewerName}] ${finding}`);
      } else if (finding.includes('代码') || finding.includes('语法')) {
        allReasons.codeQuality.push(`[${result.reviewerName}] ${finding}`);
      } else if (finding.includes('安全') || finding.includes('风险')) {
        allReasons.security.push(`[${result.reviewerName}] ${finding}`);
      } else {
        allReasons.toolEfficiency.push(`[${result.reviewerName}] ${finding}`);
      }
    }
  }

  if (codeVerification.hasCode && !codeVerification.syntaxValid) {
    allScores.codeQuality.push(50);
    allReasons.codeQuality.push('[代码验证] 检测到语法错误');
  }

  // 瑞士奶酪聚合（保守：min * 0.4 + avg * 0.6）
  const aggregateScore = (scores: number[]): number => {
    if (scores.length === 0) return 70;
    const min = Math.min(...scores);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.round(min * 0.4 + avg * 0.6);
  };

  // 代码 Grader 分数
  const selfRepairScore = transcriptMetrics.selfRepair.attempts === 0
    ? 80 // 无需修复
    : Math.min(100, transcriptMetrics.selfRepair.rate + 10); // 修复率 + 10 bonus

  const verificationScore = transcriptMetrics.verificationQuality.editCount === 0
    ? 80
    : Math.min(100, transcriptMetrics.verificationQuality.rate + 10);

  const forbiddenScore = transcriptMetrics.forbiddenPatterns.count === 0
    ? 100
    : Math.max(0, 100 - transcriptMetrics.forbiddenPatterns.count * 30);

  const metrics: SwissCheeseResult['aggregatedMetrics'] = {
    outcomeVerification: {
      score: aggregateScore(allScores.outcomeVerification),
      reasons: allReasons.outcomeVerification.slice(0, 3),
    },
    codeQuality: {
      score: aggregateScore(allScores.codeQuality),
      reasons: allReasons.codeQuality.slice(0, 3),
    },
    security: {
      score: aggregateScore(allScores.security),
      reasons: allReasons.security.slice(0, 3),
    },
    toolEfficiency: {
      score: aggregateScore(allScores.toolEfficiency),
      reasons: allReasons.toolEfficiency.slice(0, 3),
    },
    selfRepair: {
      score: selfRepairScore,
      reasons: transcriptMetrics.selfRepair.chains.length > 0
        ? [`${transcriptMetrics.selfRepair.successes}/${transcriptMetrics.selfRepair.attempts} 次修复成功`]
        : ['无需自我修复'],
    },
    verificationQuality: {
      score: verificationScore,
      reasons: transcriptMetrics.verificationQuality.editCount > 0
        ? [`${transcriptMetrics.verificationQuality.verifiedCount}/${transcriptMetrics.verificationQuality.editCount} 次编辑后验证`]
        : ['无编辑操作'],
    },
    forbiddenPatterns: {
      score: forbiddenScore,
      reasons: transcriptMetrics.forbiddenPatterns.detected.length > 0
        ? [`检测到禁止命令: ${transcriptMetrics.forbiddenPatterns.detected.join(', ')}`]
        : ['未检测到禁止模式'],
    },
  };

  // v3 加权综合得分 (支持 scoringConfig 权重覆盖)
  const defaultWeights: Record<string, number> = {
    outcomeVerification: 0.35,
    codeQuality: 0.20,
    security: 0.15,
    toolEfficiency: 0.08,
    selfRepair: 0.05,
    verificationQuality: 0.04,
    forbiddenPatterns: 0.03,
    buffer: 0.10,
  };

  // Apply scoringConfig overrides if provided, then normalize weights to sum to 1.0
  const w = { ...defaultWeights };
  if (scoringConfig && scoringConfig.length > 0) {
    for (const entry of scoringConfig) {
      if (entry.dimension in w) {
        // Normalize: if weight > 1, treat as percentage; clamp negatives to 0
        const raw = entry.weight > 1 ? entry.weight / 100 : entry.weight;
        w[entry.dimension] = Math.max(0, raw);
      }
    }

    // Normalize all weights so they sum to 1.0
    const weightSum = Object.values(w).reduce((a, b) => a + b, 0);
    if (weightSum > 0) {
      for (const key of Object.keys(w)) {
        w[key] = w[key] / weightSum;
      }
    } else {
      // All weights are zero — fallback to defaults
      Object.assign(w, defaultWeights);
    }
  }

  const overallScore = Math.round(
    metrics.outcomeVerification.score * w.outcomeVerification +
    metrics.codeQuality.score * w.codeQuality +
    metrics.security.score * w.security +
    metrics.toolEfficiency.score * w.toolEfficiency +
    metrics.selfRepair.score * w.selfRepair +
    metrics.verificationQuality.score * w.verificationQuality +
    metrics.forbiddenPatterns.score * w.forbiddenPatterns +
    ((metrics.outcomeVerification.score + metrics.codeQuality.score) / 2) * w.buffer
  );

  // 收集建议
  const suggestions: string[] = [];
  for (const result of reviewerResults) {
    for (const concern of result.concerns) {
      if (!suggestions.includes(concern)) {
        suggestions.push(concern);
      }
    }
  }
  if (transcriptMetrics.selfRepair.rate < 50 && transcriptMetrics.selfRepair.attempts > 0) {
    suggestions.push('自我修复成功率较低，建议改进错误恢复策略');
  }
  if (transcriptMetrics.verificationQuality.rate < 50 && transcriptMetrics.verificationQuality.editCount > 0) {
    suggestions.push('编辑后验证率较低，建议在修改文件后立即验证');
  }
  if (transcriptMetrics.forbiddenPatterns.count > 0) {
    suggestions.push('检测到危险命令，应避免使用破坏性操作');
  }

  const passedCount = reviewerResults.filter((r) => r.passed).length;
  const summary = `${passedCount}/${reviewerResults.length} 位评审员通过，综合得分 ${overallScore}。` +
    ` 自修复率 ${transcriptMetrics.selfRepair.rate}%，验证率 ${transcriptMetrics.verificationQuality.rate}%。` +
    (codeVerification.hasCode
      ? ` ${codeVerification.codeBlocks} 个代码块，语法${codeVerification.syntaxValid ? '正确' : '有误'}。`
      : '');

  return { overallScore, metrics, suggestions: suggestions.slice(0, 5), summary };
}
