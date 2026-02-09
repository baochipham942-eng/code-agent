// ============================================================================
// EvalDashboard - 单页 Dashboard（对标 SpreadsheetBench Viewer）
// ============================================================================
// 替代 3-Tab 布局，将所有评测信息整合到一个滚动视图中
// ============================================================================

import React, { useCallback } from 'react';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import type { EvaluationResult } from '../../../../shared/types/evaluation';
import { ScoreSummary } from './ScoreSummary';
import { GraderGrid } from './GraderGrid';
import { ErrorTags } from './ErrorTags';
import { MetricStrip } from './MetricStrip';
import { TurnTimeline } from './TurnTimeline';
import { CollapsibleSection } from './CollapsibleSection';

interface EvalDashboardProps {
  sessionId: string;
}

export const EvalDashboard: React.FC<EvalDashboardProps> = ({ sessionId }) => {
  const { sessionInfo, objective, latestEvaluation, eventSummary, loadSession } =
    useEvalCenterStore();

  // Extract typed evaluation result
  const evaluation = extractEvaluation(latestEvaluation);

  const handleEvaluationComplete = useCallback(async () => {
    // Reload session data to refresh everything
    await loadSession(sessionId);
  }, [loadSession, sessionId]);

  return (
    <div className="p-4 space-y-4 overflow-y-auto">
      {/* Score Summary */}
      <ScoreSummary
        evaluation={evaluation}
        sessionInfo={sessionInfo}
        sessionId={sessionId}
        onEvaluationComplete={handleEvaluationComplete}
      />

      {/* Grader Card Grid */}
      {evaluation && evaluation.metrics.length > 0 && (
        <GraderGrid metrics={evaluation.metrics} />
      )}

      {/* Error Tags */}
      {evaluation?.transcriptMetrics?.errorTaxonomy && (
        <ErrorTags errorTaxonomy={evaluation.transcriptMetrics.errorTaxonomy} />
      )}

      {/* Token & Cost Strip */}
      <MetricStrip objective={objective} />

      {/* Turn Timeline */}
      <TurnTimeline eventSummary={eventSummary} sessionId={sessionId} />

      {/* Suggestions */}
      {evaluation && evaluation.topSuggestions.length > 0 && (
        <CollapsibleSection title="改进建议" defaultOpen>
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <ul className="space-y-1">
              {evaluation.topSuggestions.map((suggestion, i) => (
                <li key={i} className="text-xs text-yellow-200/80">
                  {i + 1}. {suggestion}
                </li>
              ))}
            </ul>
          </div>
        </CollapsibleSection>
      )}

      {/* AI Summary */}
      {evaluation?.aiSummary && (
        <div className="text-xs text-zinc-500 bg-zinc-800/20 rounded-lg p-3 italic">
          {evaluation.aiSummary}
        </div>
      )}
    </div>
  );
};

/**
 * Extract EvaluationResult from the store's loosely-typed latestEvaluation.
 * The store stores it as `unknown`; we need to handle both the v2 format
 * (with `subjective` wrapper) and v3 format (direct EvaluationResult).
 */
function extractEvaluation(raw: unknown): EvaluationResult | null {
  if (!raw) return null;

  // v3 format: direct EvaluationResult with metrics[]
  if (isEvaluationResult(raw)) return raw;

  // v2 format: { subjective: { overallScore, ... } } — convert
  const obj = raw as Record<string, unknown>;
  if (obj.subjective && typeof obj.subjective === 'object') {
    const sub = obj.subjective as Record<string, unknown>;
    if (typeof sub.overallScore === 'number') {
      return {
        id: (sub.id as string) || '',
        sessionId: (sub.sessionId as string) || '',
        timestamp: (sub.evaluatedAt as number) || Date.now(),
        overallScore: sub.overallScore as number,
        grade: (sub.grade as EvaluationResult['grade']) || 'F',
        metrics: convertAggregatedMetrics(sub.aggregatedMetrics),
        statistics: {
          duration: 0,
          turnCount: 0,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
        },
        topSuggestions: (sub.suggestions as string[]) || [],
        aiSummary: sub.summary as string | undefined,
      };
    }
  }

  return null;
}

function isEvaluationResult(obj: unknown): obj is EvaluationResult {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.metrics) && typeof o.overallScore === 'number';
}

function convertAggregatedMetrics(
  raw: unknown
): EvaluationResult['metrics'] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = Object.entries(raw as Record<string, { score: number; reasons?: string[] }>);
  return entries.map(([key, data]) => ({
    dimension: key as EvaluationResult['metrics'][0]['dimension'],
    score: data.score ?? 0,
    weight: 0,
    details: data.reasons?.length ? { reason: data.reasons.join('; ') } : undefined,
    informational: false,
  }));
}
