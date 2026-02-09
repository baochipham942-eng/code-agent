// ============================================================================
// EvalSessionHeader - 评测中心共享会话头部
// ============================================================================

import React from 'react';

interface SessionInfo {
  title: string;
  modelProvider: string;
  modelName: string;
  startTime: number;
  endTime?: number;
  generationId: string;
  workingDirectory: string;
  status: string;
  turnCount: number;
  totalTokens: number;
  estimatedCost: number;
}

interface EvalSessionHeaderProps {
  sessionInfo: SessionInfo | null;
  isLoading?: boolean;
}

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatDuration = (start: number, end?: number): string => {
  const ms = (end || Date.now()) - start;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const statusLabels: Record<string, { text: string; cls: string }> = {
  recording: { text: '录制中', cls: 'bg-green-500/20 text-green-400' },
  completed: { text: '已完成', cls: 'bg-zinc-600/30 text-zinc-400' },
  error: { text: '错误', cls: 'bg-red-500/20 text-red-400' },
};

export const EvalSessionHeader: React.FC<EvalSessionHeaderProps> = ({ sessionInfo, isLoading }) => {
  if (isLoading) {
    return (
      <div className="px-4 py-3 border-b border-zinc-700/50 animate-pulse">
        <div className="h-4 bg-zinc-700/50 rounded w-48 mb-2" />
        <div className="h-3 bg-zinc-700/30 rounded w-72" />
      </div>
    );
  }

  if (!sessionInfo) return null;

  const st = statusLabels[sessionInfo.status] || statusLabels.completed;

  return (
    <div className="px-4 py-3 border-b border-zinc-700/50 bg-zinc-800/20">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-sm font-medium text-zinc-200 truncate max-w-[500px]">
          {sessionInfo.title}
        </h3>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${st.cls}`}>
          {st.text}
        </span>
      </div>
      <div className="flex items-center gap-4 text-[11px] text-zinc-500">
        <span>{sessionInfo.modelProvider}/{sessionInfo.modelName}</span>
        {sessionInfo.generationId && <span>{sessionInfo.generationId}</span>}
        <span>{formatTime(sessionInfo.startTime)}</span>
        <span>{formatDuration(sessionInfo.startTime, sessionInfo.endTime)}</span>
        <span>{sessionInfo.turnCount} 轮</span>
        <span>{Math.round(sessionInfo.totalTokens / 1000)}K tokens</span>
        {sessionInfo.estimatedCost > 0 && (
          <span>${sessionInfo.estimatedCost.toFixed(4)}</span>
        )}
      </div>
    </div>
  );
};
