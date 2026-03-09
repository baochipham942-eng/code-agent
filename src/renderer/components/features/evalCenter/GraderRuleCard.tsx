// ============================================================================
// GraderRuleCard - 评分维度配置卡片（用于 ScoringConfigPage）
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type GraderType = 'llm' | 'rule' | 'code';
export type Importance = 'critical' | 'high' | 'medium' | 'low';

export interface DimensionConfig {
  name: string;
  label: string;
  weight: number;
  graderType: GraderType;
  description: string;
  importance: Importance;
  judgePrompt?: string;
}

const GRADER_TYPE_BADGE: Record<GraderType, { label: string; className: string }> = {
  llm: { label: 'LLM', className: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  rule: { label: 'Rule', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  code: { label: 'Code', className: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30' },
};

const IMPORTANCE_BADGE: Record<Importance, { label: string; className: string }> = {
  critical: { label: 'CRITICAL', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  high: { label: 'HIGH', className: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  medium: { label: 'MEDIUM', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  low: { label: 'LOW', className: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30' },
};

const IMPORTANCE_BORDER: Record<Importance, string> = {
  critical: 'border-l-red-500/60',
  high: 'border-l-orange-500/60',
  medium: 'border-l-blue-500/60',
  low: 'border-l-border-strong',
};

interface GraderRuleCardProps {
  dimension: DimensionConfig;
  onWeightChange: (weight: number) => void;
  onJudgePromptChange?: (prompt: string) => void;
}

export const GraderRuleCard: React.FC<GraderRuleCardProps> = ({
  dimension,
  onWeightChange,
  onJudgePromptChange,
}) => {
  const [promptExpanded, setPromptExpanded] = useState(false);

  const graderBadge = GRADER_TYPE_BADGE[dimension.graderType];
  const importanceBadge = IMPORTANCE_BADGE[dimension.importance];
  const borderClass = IMPORTANCE_BORDER[dimension.importance];

  // Preview: first 2 lines of judge prompt
  const promptPreview = dimension.judgePrompt
    ? dimension.judgePrompt.split('\n').slice(0, 2).join(' ').slice(0, 80) + (dimension.judgePrompt.length > 80 ? '...' : '')
    : '';

  return (
    <div className={`bg-zinc-800 rounded-lg border border-zinc-800 border-l-2 ${borderClass} p-3 flex flex-col gap-2.5`}>
      {/* Header: name + badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-zinc-200">{dimension.label}</span>
          <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{dimension.description}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${graderBadge.className}`}>
            {graderBadge.label}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${importanceBadge.className}`}>
            {importanceBadge.label}
          </span>
        </div>
      </div>

      {/* Weight slider */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-500 w-6">W:</span>
        <input
          type="range"
          min="0"
          max="50"
          value={dimension.weight}
          onChange={(e) => {
            const v = parseInt(e.target.value);
            onWeightChange(Number.isFinite(v) ? v : 0);
          }}
          className="flex-1 h-1 appearance-none bg-zinc-600 rounded-full cursor-pointer"
        />
        <span className="text-xs text-zinc-400 w-8 text-right font-mono">{dimension.weight}%</span>
      </div>

      {/* Judge Prompt section (LLM type only) */}
      {dimension.graderType === 'llm' && (
        <div className="border-t border-zinc-800 pt-2">
          <button
            onClick={() => setPromptExpanded(!promptExpanded)}
            className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-400 transition w-full"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${promptExpanded ? '' : '-rotate-90'}`} />
            <span>Judge Prompt</span>
            {!promptExpanded && promptPreview && (
              <span className="text-zinc-600 truncate flex-1 text-left ml-1">{promptPreview}</span>
            )}
          </button>
          {promptExpanded && (
            <div className="mt-2 space-y-2">
              <textarea
                value={dimension.judgePrompt || ''}
                onChange={(e) => onJudgePromptChange?.(e.target.value)}
                rows={5}
                className="w-full bg-zinc-900/60 border border-zinc-700 rounded-md p-2 text-[11px] text-zinc-400 leading-relaxed resize-y focus:outline-none focus:border-zinc-600 placeholder-zinc-600"
                placeholder="输入自定义 Judge Prompt..."
              />
              <button
                onClick={() => alert('AI prompt optimization coming soon')}
                className="text-[10px] px-2 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded hover:bg-amber-500/20 transition"
              >
                AI 建议
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
