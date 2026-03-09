// ============================================================================
// AgentStatsBar - Agent 运行时统计状态栏
// 显示任务时长、上下文使用量、工具调用次数、迭代次数
// 以及上下文压缩（compaction）指示器
// 灵感来源: Claude Code "✳ Compacting conversation… (8m 4s · ↑ 24.8k tokens)"
// ============================================================================

import React, { useEffect, useState } from 'react';
import type { TaskStatsData } from '@shared/types/agent';

// ============================================================================
// Types
// ============================================================================

export interface CompactionStatus {
  isCompacting: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  messagesRemoved?: number;
  duration_ms?: number;
  showResult?: boolean;
}

export interface AgentStatsBarProps {
  taskStats: TaskStatsData | null;
  compactionStatus: CompactionStatus | null;
  isProcessing: boolean;
  className?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toString();
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Compaction indicator (Claude Code style)
 */
const CompactionIndicator: React.FC<{ status: CompactionStatus }> = ({ status }) => {
  if (status.isCompacting) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg animate-pulse">
        <span className="text-amber-400 text-sm font-bold">&#10035;</span>
        <span className="text-amber-300 text-xs font-medium">
          Compacting conversation...
          {status.tokensBefore != null && (
            <span className="text-amber-400/70 ml-1">
              ({'\u2191'} {formatTokens(status.tokensBefore)} tokens)
            </span>
          )}
        </span>
      </div>
    );
  }

  if (status.showResult && status.tokensBefore != null && status.tokensAfter != null) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg transition-opacity duration-1000">
        <span className="text-emerald-400 text-sm font-bold">&#10035;</span>
        <span className="text-emerald-300 text-xs font-medium">
          Compacted: {formatTokens(status.tokensBefore)} {'\u2192'} {formatTokens(status.tokensAfter)} tokens
          {status.duration_ms != null && (
            <span className="text-emerald-400/70 ml-1">
              ({formatDuration(status.duration_ms)})
            </span>
          )}
        </span>
      </div>
    );
  }

  return null;
};

// ============================================================================
// Main Component
// ============================================================================

export const AgentStatsBar: React.FC<AgentStatsBarProps> = ({
  taskStats,
  compactionStatus,
  isProcessing,
  className = '',
}) => {
  // Live elapsed time ticker
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isProcessing || !taskStats) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isProcessing, taskStats]);

  // Don't render if not processing and no compaction result showing
  if (!isProcessing && !compactionStatus?.showResult) return null;
  if (!taskStats && !compactionStatus) return null;

  const usagePercent = taskStats ? Math.round(taskStats.contextUsage * 100) : 0;

  // Context usage color
  const getUsageColor = (pct: number) => {
    if (pct >= 90) return 'text-red-400';
    if (pct >= 70) return 'text-amber-400';
    return 'text-text-secondary';
  };

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {/* Compaction indicator */}
      {compactionStatus && <CompactionIndicator status={compactionStatus} />}

      {/* Stats bar */}
      {taskStats && isProcessing && (
        <div className="flex items-center gap-3 px-3 py-1 bg-surface border border-border-subtle rounded-lg text-xs">
          {/* Duration */}
          <div className="flex items-center gap-1 text-text-secondary" title="Task duration">
            <span>{'\u23F1'}</span>
            <span className="font-mono text-text-secondary">
              {formatDuration(taskStats.elapsed_ms)}
            </span>
          </div>

          <div className="w-px h-3 bg-hover" />

          {/* Context usage */}
          <div
            className={`flex items-center gap-1 ${getUsageColor(usagePercent)}`}
            title={`Context: ${formatTokens(taskStats.tokensUsed)} / ${formatTokens(taskStats.contextWindow)} tokens`}
          >
            <span>{'\uD83D\uDCCA'}</span>
            <span className="font-mono">
              {formatTokens(taskStats.tokensUsed)} / {formatTokens(taskStats.contextWindow)}
            </span>
            <span className="text-text-tertiary">({usagePercent}%)</span>
          </div>

          <div className="w-px h-3 bg-hover" />

          {/* Tool calls */}
          <div className="flex items-center gap-1 text-text-secondary" title="Tool calls">
            <span>{'\uD83D\uDD27'}</span>
            <span className="font-mono text-text-secondary">{taskStats.toolCallCount} calls</span>
          </div>

          <div className="w-px h-3 bg-hover" />

          {/* Iterations */}
          <div className="flex items-center gap-1 text-text-secondary" title="Iterations">
            <span>{'\uD83D\uDD04'}</span>
            <span className="font-mono text-text-secondary">{taskStats.iterations} iterations</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentStatsBar;
