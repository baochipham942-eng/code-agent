// ============================================================================
// SemanticResearchIndicator - 语义研究检测指示器
// 当检测到需要深度研究时显示
// ============================================================================

import React from 'react';
import { Zap, Microscope, X } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export interface SemanticResearchIndicatorProps {
  /** 检测到的意图 */
  intent: string;
  /** 置信度 (0-1) */
  confidence: number;
  /** 建议的深度 */
  suggestedDepth: 'quick' | 'standard' | 'deep';
  /** 推理理由 */
  reasoning?: string;
  /** 是否显示 */
  visible: boolean;
  /** 关闭回调 */
  onDismiss?: () => void;
}

// ============================================================================
// 常量配置
// ============================================================================

const INTENT_LABELS: Record<string, string> = {
  simple_lookup: '简单查询',
  factual_question: '事实问题',
  explanation: '解释说明',
  comparison: '对比研究',
  analysis: '深度分析',
  current_events: '时事新闻',
  technical_deep_dive: '技术深挖',
  multi_faceted: '多面分析',
  code_task: '代码任务',
  creative_task: '创意任务',
};

const DEPTH_LABELS: Record<string, string> = {
  quick: '快速查询',
  standard: '标准研究',
  deep: '深度研究',
};

const DEPTH_COLORS: Record<string, string> = {
  quick: 'text-green-400 bg-green-500/20',
  standard: 'text-amber-400 bg-amber-500/20',
  deep: 'text-primary-400 bg-primary-500/20',
};

// ============================================================================
// 组件
// ============================================================================

export const SemanticResearchIndicator: React.FC<SemanticResearchIndicatorProps> = ({
  intent,
  confidence,
  suggestedDepth,
  reasoning,
  visible,
  onDismiss,
}) => {
  if (!visible) return null;

  const intentLabel = INTENT_LABELS[intent] || intent;
  const depthLabel = DEPTH_LABELS[suggestedDepth] || suggestedDepth;
  const depthColor = DEPTH_COLORS[suggestedDepth] || 'text-zinc-400 bg-zinc-500/20';

  return (
    <div className="px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg animate-in slide-in-from-top-2 duration-200">
      <div className="flex items-start gap-2">
        <div className="p-1 bg-amber-500/20 rounded">
          <Zap className="w-3.5 h-3.5 text-amber-400" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-amber-400">
              已自动启用深度研究
            </span>
            <span className={`px-1.5 py-0.5 text-2xs rounded ${depthColor}`}>
              {depthLabel}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-1 text-2xs text-zinc-500">
            <span>意图: {intentLabel}</span>
            <span>•</span>
            <span>置信度: {Math.round(confidence * 100)}%</span>
          </div>

          {reasoning && (
            <div className="mt-1 text-2xs text-zinc-500 truncate">
              {reasoning}
            </div>
          )}
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
