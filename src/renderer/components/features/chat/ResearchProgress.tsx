// ============================================================================
// ResearchProgress - 深度研究进度展示组件
// 显示研究阶段、进度条和当前执行步骤
// 支持语义自动触发模式的增强信息显示
// ============================================================================

import React from 'react';
import {
  Loader2,
  CheckCircle,
  AlertCircle,
  FileText,
  Search,
  Brain,
  Microscope,
  Zap,
  Database,
  TrendingUp,
  RefreshCw,
} from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export type ResearchPhase = 'planning' | 'researching' | 'reporting' | 'complete' | 'error';

export interface ResearchStep {
  title: string;
  status: 'running' | 'completed' | 'failed';
}

export interface ResearchProgressProps {
  phase: ResearchPhase;
  message: string;
  percent: number;
  currentStep?: ResearchStep;
  error?: string;
  /** 触发方式 */
  triggeredBy?: 'semantic' | 'manual';
  /** 当前迭代轮数 */
  currentIteration?: number;
  /** 最大迭代轮数 */
  maxIterations?: number;
  /** 覆盖度（0-1） */
  coverage?: number;
  /** 当前使用的数据源 */
  activeSources?: string[];
  /** 是否可以继续深入 */
  canDeepen?: boolean;
  /** 继续深入回调 */
  onDeepen?: () => void;
  /** 停止回调 */
  onStop?: () => void;
}

// ============================================================================
// 常量配置
// ============================================================================

const PHASE_ICONS: Record<ResearchPhase, React.ReactNode> = {
  planning: <Brain className="w-5 h-5" />,
  researching: <Search className="w-5 h-5" />,
  reporting: <FileText className="w-5 h-5" />,
  complete: <CheckCircle className="w-5 h-5 text-green-400" />,
  error: <AlertCircle className="w-5 h-5 text-red-400" />,
};

const PHASE_LABELS: Record<ResearchPhase, string> = {
  planning: '制定计划',
  researching: '执行研究',
  reporting: '生成报告',
  complete: '研究完成',
  error: '研究失败',
};

const PHASE_ORDER: ResearchPhase[] = ['planning', 'researching', 'reporting'];

/** 数据源显示名称 */
const SOURCE_LABELS: Record<string, string> = {
  web_search: '网络搜索',
  news_search: '新闻搜索',
  academic_search: '学术搜索',
  code_search: '代码搜索',
  documentation: '官方文档',
  mcp_deepwiki: 'DeepWiki',
  mcp_github: 'GitHub',
  local_codebase: '本地代码',
  memory_store: '记忆库',
};

// ============================================================================
// 组件
// ============================================================================

export const ResearchProgress: React.FC<ResearchProgressProps> = ({
  phase,
  message,
  percent,
  currentStep,
  error,
  triggeredBy,
  currentIteration,
  maxIterations,
  coverage,
  activeSources,
  canDeepen,
  onDeepen,
  onStop,
}) => {
  const isActive = phase !== 'complete' && phase !== 'error';
  const currentPhaseIndex = PHASE_ORDER.indexOf(phase);
  const isSemanticTriggered = triggeredBy === 'semantic';
  const hasEnhancedInfo = currentIteration !== undefined || coverage !== undefined || activeSources;

  return (
    <div className="p-4 bg-surface-800/50 border border-zinc-700/50 rounded-lg mb-4">
      {/* 顶部状态栏 */}
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${isActive ? 'bg-primary-500/20' : 'bg-surface-700'}`}>
          {isActive ? (
            <Loader2 className="w-5 h-5 text-primary-400 animate-spin" />
          ) : (
            PHASE_ICONS[phase]
          )}
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Microscope className="w-4 h-4 text-primary-400" />
            <span className="text-sm font-medium text-white">
              深度研究 - {PHASE_LABELS[phase]}
            </span>
            {/* 语义触发标识 */}
            {isSemanticTriggered && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 text-2xs rounded-full">
                <Zap className="w-3 h-3" />
                自动触发
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-400 mt-0.5">
            {message}
          </div>
        </div>

        <div className="text-sm text-zinc-500 font-mono">
          {percent}%
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 bg-surface-700 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ease-out ${
            phase === 'error' ? 'bg-red-500' :
            phase === 'complete' ? 'bg-green-500' :
            'bg-primary-500'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* 阶段指示器 */}
      <div className="flex items-center justify-between mt-3 px-1">
        {PHASE_ORDER.map((p, index) => {
          const isCompleted = index < currentPhaseIndex || phase === 'complete';
          const isCurrent = p === phase;

          return (
            <div key={p} className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full transition-colors ${
                isCompleted ? 'bg-green-400' :
                isCurrent ? 'bg-primary-400 animate-pulse' :
                'bg-zinc-600'
              }`} />
              <span className={`text-xs transition-colors ${
                isCompleted ? 'text-green-400' :
                isCurrent ? 'text-primary-400' :
                'text-zinc-600'
              }`}>
                {PHASE_LABELS[p]}
              </span>
            </div>
          );
        })}
      </div>

      {/* 增强信息区域（语义研究模式） */}
      {hasEnhancedInfo && (
        <div className="mt-3 pt-3 border-t border-zinc-700/50 space-y-2">
          {/* 迭代和覆盖度 */}
          <div className="flex items-center justify-between">
            {currentIteration !== undefined && maxIterations !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <RefreshCw className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-zinc-400">
                  迭代 {currentIteration}/{maxIterations}
                </span>
              </div>
            )}

            {coverage !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <TrendingUp className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-zinc-400">
                  覆盖度 {Math.round(coverage * 100)}%
                </span>
                {/* 覆盖度小进度条 */}
                <div className="w-16 h-1 bg-surface-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 transition-all duration-300"
                    style={{ width: `${coverage * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 数据源 */}
          {activeSources && activeSources.length > 0 && (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <Database className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span className="text-zinc-500 shrink-0">数据源:</span>
              {activeSources.map((source) => (
                <span
                  key={source}
                  className="px-1.5 py-0.5 bg-surface-700 text-zinc-400 rounded text-2xs"
                >
                  {SOURCE_LABELS[source] || source}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 当前步骤详情 */}
      {currentStep && (
        <div className="mt-3 pt-3 border-t border-zinc-700/50">
          <div className="flex items-center gap-2 text-xs">
            {currentStep.status === 'running' && (
              <Loader2 className="w-3 h-3 text-primary-400 animate-spin" />
            )}
            {currentStep.status === 'completed' && (
              <CheckCircle className="w-3 h-3 text-green-400" />
            )}
            {currentStep.status === 'failed' && (
              <AlertCircle className="w-3 h-3 text-red-400" />
            )}
            <span className="text-zinc-400">{currentStep.title}</span>
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      {isActive && (onDeepen || onStop) && (
        <div className="mt-3 pt-3 border-t border-zinc-700/50 flex items-center gap-2">
          {canDeepen && onDeepen && (
            <button
              type="button"
              onClick={onDeepen}
              className="px-3 py-1.5 text-xs bg-primary-500/20 text-primary-400 rounded-md hover:bg-primary-500/30 transition-colors"
            >
              继续深入
            </button>
          )}
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="px-3 py-1.5 text-xs bg-zinc-700 text-zinc-300 rounded-md hover:bg-zinc-600 transition-colors"
            >
              停止研究
            </button>
          )}
        </div>
      )}

      {/* 错误信息 */}
      {error && (
        <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
};
