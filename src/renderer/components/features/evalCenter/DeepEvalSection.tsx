// ============================================================================
// DeepEvalSection - 深度评测 Tab（AI 评测部分）
// ============================================================================

import React, { useState, useCallback } from 'react';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import {
  scoreToGrade,
  GRADE_COLORS,
  GRADE_BG_COLORS,
  DIMENSION_NAMES,
  DIMENSION_ICONS,
  type SubjectiveDimension,
} from '../../../../shared/types/sessionAnalytics';

interface HistoricalEvaluation {
  id: string;
  timestamp: number;
  overallScore: number;
  grade: string;
}

interface ReviewerResult {
  reviewerId: string;
  reviewerName: string;
  perspective: string;
  scores: Record<string, number>;
  findings: string[];
  concerns: string[];
  passed: boolean;
}

interface CodeVerification {
  hasCode: boolean;
  codeBlocks: number;
  syntaxValid: boolean;
  executionAttempted: boolean;
  executionSuccess: boolean;
  errors: string[];
}

interface SubjectiveResult {
  overallScore: number;
  grade: string;
  summary?: string;
  evaluatedAt: number;
  provider: string;
  model: string;
  consensus: boolean;
  passedReviewers: number;
  reviewerCount: number;
  suggestions: string[];
  reviewerResults?: ReviewerResult[];
  codeVerification?: CodeVerification;
  aggregatedMetrics?: Record<string, { score: number; reasons: string[] }>;
}

interface DeepEvalSectionProps {
  sessionId: string;
  previousEvaluations: HistoricalEvaluation[];
  latestEvaluation: { subjective?: SubjectiveResult } | null;
}

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export const DeepEvalSection: React.FC<DeepEvalSectionProps> = ({
  sessionId,
  previousEvaluations,
  latestEvaluation,
}) => {
  const [subjective, setSubjective] = useState<SubjectiveResult | null>(
    latestEvaluation?.subjective || null
  );
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runEvaluation = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      setIsEvaluating(true);
      setError(null);
      const result = await window.electronAPI.invoke(
        IPC_CHANNELS.EVALUATION_RUN_SUBJECTIVE,
        { sessionId, save: true }
      );
      setSubjective(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '评测失败');
    } finally {
      setIsEvaluating(false);
    }
  }, [sessionId]);

  return (
    <div className="space-y-4">
      {/* 历史评测记录 */}
      {previousEvaluations.length > 0 && (
        <div className="bg-zinc-800/30 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-2">历史评测记录</div>
          <div className="space-y-1">
            {previousEvaluations.map((eval_) => (
              <div key={eval_.id} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{formatTime(eval_.timestamp)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-white">{eval_.overallScore}</span>
                  <span className={`${GRADE_COLORS[eval_.grade]} ${GRADE_BG_COLORS[eval_.grade]} px-2 py-0.5 rounded text-xs font-bold`}>
                    {eval_.grade}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 未评测状态 */}
      {!subjective && !isEvaluating && (
        <div className="bg-zinc-800/30 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">🧀</div>
          <p className="text-sm text-gray-400 mb-4">
            使用 4 位 AI 评审员进行多视角深度分析
          </p>
          <div className="text-xs text-gray-500 mb-4">
            📋 任务分析师 · 💻 代码审查员 · 🔒 安全审计员 · 👤 用户体验专家
          </div>
          <button
            onClick={runEvaluation}
            className="px-6 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition flex items-center gap-2 mx-auto"
          >
            <span>🧀</span>
            开始深度评测
          </button>
        </div>
      )}

      {/* 评测中 */}
      {isEvaluating && (
        <div className="bg-zinc-800/30 rounded-lg p-6 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-3" />
          <div className="text-gray-300">瑞士奶酪评测进行中...</div>
          <div className="text-xs text-gray-500 mt-2">4 位 AI 评审员正在分析</div>
        </div>
      )}

      {/* 错误 */}
      {error && !subjective && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-center">
          <div className="text-red-400 mb-2">评测失败</div>
          <div className="text-xs text-gray-500 mb-3">{error}</div>
          <button
            onClick={runEvaluation}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
          >
            重试评测
          </button>
        </div>
      )}

      {/* 评测结果 */}
      {subjective && (
        <>
          {/* 综合得分 */}
          <div className="bg-zinc-800/50 rounded-lg p-4 flex items-center gap-6">
            <div className="text-center">
              <div className="text-5xl font-bold text-white">{subjective.overallScore}</div>
              <div className={`inline-block ${GRADE_COLORS[subjective.grade]} ${GRADE_BG_COLORS[subjective.grade]} px-3 py-1 rounded-full text-lg font-bold mt-1`}>
                {subjective.grade}
              </div>
            </div>
            <div className="flex-1">
              <div className="text-sm text-gray-400 mb-2">
                评测模型: {subjective.provider}/{subjective.model}
              </div>
              {subjective.summary && (
                <div className="text-sm text-indigo-300 bg-indigo-500/10 border border-indigo-500/30 rounded p-2">
                  {subjective.summary}
                </div>
              )}
            </div>
          </div>

          {/* 评审员共识 */}
          {subjective.reviewerResults && (
            <div className="bg-zinc-800/30 rounded-lg p-3">
              <div className="text-xs text-gray-400 mb-2 flex items-center gap-2">
                <span>🧀 瑞士奶酪评审团</span>
                <span className={subjective.consensus ? 'text-green-400' : 'text-yellow-400'}>
                  ({subjective.passedReviewers}/{subjective.reviewerCount} 通过)
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {subjective.reviewerResults.map((reviewer) => (
                  <div
                    key={reviewer.reviewerId}
                    className={`p-2 rounded border ${
                      reviewer.passed
                        ? 'border-green-500/30 bg-green-500/5'
                        : 'border-red-500/30 bg-red-500/5'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-200">{reviewer.reviewerName}</span>
                      <span className={reviewer.passed ? 'text-green-400' : 'text-red-400'}>
                        {reviewer.passed ? '✓' : '✗'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500">{reviewer.perspective}</div>
                    {reviewer.findings.length > 0 && (
                      <div className="text-xs text-gray-400 mt-1">
                        • {reviewer.findings[0]}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 维度得分 */}
          {subjective.aggregatedMetrics && (
            <div className="bg-zinc-800/30 rounded-lg p-3">
              <div className="text-xs text-gray-400 mb-2">维度评分</div>
              <div className="space-y-2">
                {Object.entries(subjective.aggregatedMetrics).map(([key, data]) => {
                  const dimensionKey = key.replace(/([A-Z])/g, '_$1').toLowerCase() as SubjectiveDimension;
                  const name = DIMENSION_NAMES[dimensionKey] || key;
                  const icon = DIMENSION_ICONS[dimensionKey] || '📊';
                  const score = data.score;
                  const scoreGrade = scoreToGrade(score);

                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-lg">{icon}</span>
                      <span className="text-sm text-gray-300 w-20">{name}</span>
                      <div className="flex-1 h-2 bg-zinc-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-blue-500' : score >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                          }`}
                          style={{ width: `${score}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-white w-10">{score}</span>
                      <span className={`${GRADE_COLORS[scoreGrade]} text-xs font-bold`}>{scoreGrade}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 代码验证 */}
          {subjective.codeVerification?.hasCode && (
            <div className="bg-zinc-800/30 rounded-lg p-3">
              <div className="text-xs text-gray-400 mb-2">代码验证</div>
              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-300">
                  代码块: {subjective.codeVerification.codeBlocks}
                </span>
                <span className={subjective.codeVerification.syntaxValid ? 'text-green-400' : 'text-red-400'}>
                  语法: {subjective.codeVerification.syntaxValid ? '✓ 正确' : '✗ 有误'}
                </span>
              </div>
            </div>
          )}

          {/* 改进建议 */}
          {subjective.suggestions && subjective.suggestions.length > 0 && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
              <div className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
                ⚠️ 改进建议
              </div>
              <ul className="space-y-1">
                {subjective.suggestions.map((suggestion, i) => (
                  <li key={i} className="text-sm text-yellow-200/80">• {suggestion}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 重新评测 */}
          <div className="text-center">
            <button
              onClick={runEvaluation}
              className="text-xs text-gray-500 hover:text-gray-300 transition"
            >
              🔄 重新评测
            </button>
          </div>
        </>
      )}
    </div>
  );
};
