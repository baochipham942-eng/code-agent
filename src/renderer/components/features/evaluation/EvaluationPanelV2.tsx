// ============================================================================
// EvaluationPanel v2 - 评测面板（遵循行业最佳实践）
// ============================================================================
// 流程：打开面板 → 立即加载客观指标 → 用户点击开始评测 → LLM 评测
// 参考：Anthropic, Braintrust, LangSmith, DeepEval
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import type { ObjectiveMetrics, SubjectiveAssessment } from '../../../../shared/types/sessionAnalytics';
import {
  scoreToGrade,
  GRADE_COLORS,
  GRADE_BG_COLORS,
  DIMENSION_NAMES,
  DIMENSION_ICONS,
  SubjectiveDimension,
} from '../../../../shared/types/sessionAnalytics';

interface EvaluationPanelV2Props {
  sessionId: string;
  onClose: () => void;
}

type PanelStatus = 'loading_stats' | 'stats_loaded' | 'evaluating' | 'completed' | 'error';

interface HistoricalEvaluation {
  id: string;
  timestamp: number;
  overallScore: number;
  grade: string;
}

interface ExtendedSubjectiveAssessment extends SubjectiveAssessment {
  reviewerResults?: Array<{
    reviewerId: string;
    reviewerName: string;
    perspective: string;
    scores: Record<string, number>;
    findings: string[];
    concerns: string[];
    passed: boolean;
  }>;
  codeVerification?: {
    hasCode: boolean;
    codeBlocks: number;
    syntaxValid: boolean;
    executionAttempted: boolean;
    executionSuccess: boolean;
    errors: string[];
  };
  aggregatedMetrics?: {
    taskCompletion: { score: number; reasons: string[] };
    responseQuality: { score: number; reasons: string[] };
    codeQuality: { score: number; reasons: string[] };
    efficiency: { score: number; reasons: string[] };
    safety: { score: number; reasons: string[] };
  };
}

// SSE 事件摘要类型
interface EventSummary {
  eventStats: Record<string, number>;
  toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
  thinkingContent: string[];
  errorEvents: Array<{ type: string; message: string }>;
  timeline: Array<{ time: number; type: string; summary: string }>;
}

export function EvaluationPanelV2({ sessionId, onClose }: EvaluationPanelV2Props) {
  const [status, setStatus] = useState<PanelStatus>('loading_stats');
  const [error, setError] = useState<string | null>(null);

  // 客观指标
  const [objective, setObjective] = useState<ObjectiveMetrics | null>(null);
  // 历史评测
  const [previousEvaluations, setPreviousEvaluations] = useState<HistoricalEvaluation[]>([]);
  // 主观评测结果
  const [subjective, setSubjective] = useState<ExtendedSubjectiveAssessment | null>(null);
  // SSE 事件摘要
  const [eventSummary, setEventSummary] = useState<EventSummary | null>(null);

  // 加载客观指标和历史评测
  const loadSessionAnalysis = useCallback(async () => {
    if (!window.electronAPI) {
      setError('Electron API 不可用');
      setStatus('error');
      return;
    }

    try {
      setStatus('loading_stats');
      const analysis = await window.electronAPI.invoke(
        IPC_CHANNELS.EVALUATION_GET_SESSION_ANALYSIS,
        sessionId
      );

      setObjective(analysis.objective);
      setPreviousEvaluations(analysis.previousEvaluations || []);
      setEventSummary(analysis.eventSummary || null);

      // 如果有历史评测，尝试加载最新的主观评测
      if (analysis.latestEvaluation?.subjective) {
        setSubjective(analysis.latestEvaluation.subjective);
        setStatus('completed');
      } else {
        setStatus('stats_loaded');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载会话数据失败');
      setStatus('error');
    }
  }, [sessionId]);

  // 执行主观评测
  const runSubjectiveEvaluation = useCallback(async () => {
    if (!window.electronAPI) {
      setError('Electron API 不可用');
      return;
    }

    try {
      setStatus('evaluating');
      setError(null);

      const result = await window.electronAPI.invoke(
        IPC_CHANNELS.EVALUATION_RUN_SUBJECTIVE,
        { sessionId, save: true }
      );

      setSubjective(result);
      setStatus('completed');
    } catch (err) {
      setError(err instanceof Error ? err.message : '评测失败');
      setStatus('error');
    }
  }, [sessionId]);

  // 初始加载
  useEffect(() => {
    loadSessionAnalysis();
  }, [loadSessionAnalysis]);

  // 格式化时长
  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 渲染客观指标卡片
  const renderObjectiveMetrics = () => {
    if (!objective) return null;

    return (
      <div className="space-y-4">
        {/* 基础统计 */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="会话时长" value={formatDuration(objective.duration)} icon="⏱️" />
          <StatCard label="交互轮次" value={objective.turnsCount.toString()} icon="💬" />
          <StatCard label="工具调用" value={objective.totalToolCalls.toString()} icon="🔧" />
          <StatCard
            label="成功率"
            value={`${objective.toolSuccessRate}%`}
            icon="✅"
            color={objective.toolSuccessRate >= 80 ? 'green' : objective.toolSuccessRate >= 60 ? 'yellow' : 'red'}
          />
        </div>

        {/* Token 和成本 */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="输入 Token" value={objective.totalInputTokens.toLocaleString()} icon="📥" />
          <StatCard label="输出 Token" value={objective.totalOutputTokens.toLocaleString()} icon="📤" />
          <StatCard label="代码块" value={objective.codeBlocksGenerated.toString()} icon="💻" />
          <StatCard label="预估成本" value={`$${objective.estimatedCost.toFixed(4)}`} icon="💰" />
        </div>

        {/* 工具使用分布 */}
        {Object.keys(objective.toolCallsByName).length > 0 && (
          <div className="bg-zinc-800/30 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-2">工具使用分布</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(objective.toolCallsByName)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([name, count]) => (
                  <span
                    key={name}
                    className="text-xs px-2 py-1 rounded bg-zinc-700/50 text-gray-300"
                  >
                    {name}: {count}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // 渲染 SSE 事件摘要
  const renderEventSummary = () => {
    if (!eventSummary) return null;

    const totalEvents = Object.values(eventSummary.eventStats).reduce((a, b) => a + b, 0);

    return (
      <div className="space-y-3">
        {/* 事件统计 */}
        <div className="bg-zinc-800/30 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-2">SSE 事件流 ({totalEvents} 个事件)</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(eventSummary.eventStats)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([type, count]) => (
                <span
                  key={type}
                  className="text-xs px-2 py-1 rounded bg-indigo-500/20 text-indigo-300"
                >
                  {type}: {count}
                </span>
              ))}
          </div>
        </div>

        {/* 错误事件 */}
        {eventSummary.errorEvents.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <div className="text-xs text-red-400 mb-2">错误事件 ({eventSummary.errorEvents.length})</div>
            <div className="space-y-1">
              {eventSummary.errorEvents.slice(0, 3).map((err, i) => (
                <div key={i} className="text-xs text-red-300">• {err.message}</div>
              ))}
            </div>
          </div>
        )}

        {/* 思考内容预览 */}
        {eventSummary.thinkingContent.length > 0 && (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3">
            <div className="text-xs text-purple-400 mb-2">AI 思考过程 ({eventSummary.thinkingContent.length} 段)</div>
            <div className="text-xs text-purple-300/80 max-h-20 overflow-y-auto">
              {eventSummary.thinkingContent[0]?.slice(0, 200)}...
            </div>
          </div>
        )}

        {/* 时间线预览 */}
        {eventSummary.timeline.length > 0 && (
          <div className="bg-zinc-800/30 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-2">执行时间线 (最近 {Math.min(5, eventSummary.timeline.length)} 步)</div>
            <div className="space-y-1">
              {eventSummary.timeline.slice(-5).map((item, i) => (
                <div key={i} className="text-xs text-gray-400 flex items-center gap-2">
                  <span className="text-gray-600">{new Date(item.time).toLocaleTimeString()}</span>
                  <span className="text-gray-300">{item.summary}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // 渲染历史评测
  const renderPreviousEvaluations = () => {
    if (previousEvaluations.length === 0) return null;

    return (
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
    );
  };

  // 渲染主观评测结果
  const renderSubjectiveResults = () => {
    if (!subjective) return null;

    const grade = subjective.grade;

    return (
      <div className="space-y-4">
        {/* 综合得分 */}
        <div className="bg-zinc-800/50 rounded-lg p-4 flex items-center gap-6">
          <div className="text-center">
            <div className="text-5xl font-bold text-white">{subjective.overallScore}</div>
            <div className={`inline-block ${GRADE_COLORS[grade]} ${GRADE_BG_COLORS[grade]} px-3 py-1 rounded-full text-lg font-bold mt-1`}>
              {grade}
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
                const dimension = key as keyof typeof DIMENSION_NAMES;
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
              {subjective.codeVerification.errors.length > 0 && (
                <span className="text-red-400 text-xs">
                  {subjective.codeVerification.errors[0]}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 改进建议 */}
        {subjective.suggestions && subjective.suggestions.length > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <div className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
              <span>⚠️</span> 改进建议
            </div>
            <ul className="space-y-1">
              {subjective.suggestions.map((suggestion, i) => (
                <li key={i} className="text-sm text-yellow-200/80">• {suggestion}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  // 初始加载状态
  if (status === 'loading_stats' && !objective) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-zinc-900 rounded-xl border border-zinc-700 p-6 text-center">
          <div className="animate-spin w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-3" />
          <div className="text-gray-300 text-sm">加载会话数据...</div>
        </div>
      </div>
    );
  }

  // 错误状态
  if (status === 'error' && !objective) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-zinc-900 rounded-xl border border-zinc-700 p-6 text-center max-w-md">
          <div className="text-red-400 text-3xl mb-3">⚠️</div>
          <div className="text-gray-300 mb-2">加载失败</div>
          <div className="text-xs text-gray-500 mb-4">{error}</div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={loadSessionAnalysis}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm"
            >
              重试
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-zinc-700 text-gray-300 rounded-lg hover:bg-zinc-600 transition text-sm"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-700">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🧀</span>
            <div>
              <h2 className="text-lg font-semibold text-gray-200">会话分析</h2>
              <p className="text-xs text-gray-500">瑞士奶酪多层评测模型</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-zinc-800 rounded-lg transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 客观指标（总是显示） */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">📊 客观指标</h3>
              <span className="text-xs text-gray-600">来自数据库，无需 AI</span>
            </div>
            {renderObjectiveMetrics()}
          </div>

          {/* SSE 事件流（如果有） */}
          {eventSummary && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-400">📡 SSE 事件流</h3>
                <span className="text-xs text-gray-600">完整执行日志</span>
              </div>
              {renderEventSummary()}
            </div>
          )}

          {/* 历史评测 */}
          {previousEvaluations.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3">📜 历史评测</h3>
              {renderPreviousEvaluations()}
            </div>
          )}

          {/* 主观评测部分 */}
          <div className="border-t border-zinc-700/50 pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">🤖 AI 深度评测</h3>
              {subjective && (
                <span className="text-xs text-gray-600">
                  评测于 {formatTime(subjective.evaluatedAt)}
                </span>
              )}
            </div>

            {/* 未评测状态 - 显示开始按钮 */}
            {status === 'stats_loaded' && !subjective && (
              <div className="bg-zinc-800/30 rounded-lg p-6 text-center">
                <div className="text-4xl mb-3">🧀</div>
                <p className="text-sm text-gray-400 mb-4">
                  使用 4 位 AI 评审员进行多视角深度分析
                </p>
                <div className="text-xs text-gray-500 mb-4 space-y-1">
                  <div>📋 任务分析师 · 💻 代码审查员 · 🔒 安全审计员 · 👤 用户体验专家</div>
                </div>
                <button
                  onClick={runSubjectiveEvaluation}
                  className="px-6 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition flex items-center gap-2 mx-auto"
                >
                  <span>🧀</span>
                  开始深度评测
                </button>
              </div>
            )}

            {/* 评测中状态 */}
            {status === 'evaluating' && (
              <div className="bg-zinc-800/30 rounded-lg p-6 text-center">
                <div className="animate-spin w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-3" />
                <div className="text-gray-300">瑞士奶酪评测进行中...</div>
                <div className="text-xs text-gray-500 mt-2">4 位 AI 评审员正在分析</div>
              </div>
            )}

            {/* 评测完成 - 显示结果 */}
            {(status === 'completed' || subjective) && renderSubjectiveResults()}

            {/* 评测错误 */}
            {status === 'error' && error && subjective === null && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-center">
                <div className="text-red-400 mb-2">评测失败</div>
                <div className="text-xs text-gray-500 mb-3">{error}</div>
                <button
                  onClick={runSubjectiveEvaluation}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
                >
                  重试评测
                </button>
              </div>
            )}

            {/* 重新评测按钮（已有结果时） */}
            {subjective && status === 'completed' && (
              <div className="mt-4 text-center">
                <button
                  onClick={runSubjectiveEvaluation}
                  className="text-xs text-gray-500 hover:text-gray-300 transition"
                >
                  🔄 重新评测
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 统计卡片组件
function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: string;
  color?: 'green' | 'yellow' | 'red';
}) {
  const colorClass = color === 'green'
    ? 'text-green-400'
    : color === 'yellow'
    ? 'text-yellow-400'
    : color === 'red'
    ? 'text-red-400'
    : 'text-white';

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3 text-center">
      <div className="text-lg mb-1">{icon}</div>
      <div className={`text-lg font-semibold ${colorClass}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
