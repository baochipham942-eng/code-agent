// ============================================================================
// SessionListItem - 会话卡片
// ============================================================================

import React from 'react';

interface SessionListItemProps {
  session: {
    id: string;
    title: string;
    modelProvider: string;
    modelName: string;
    startTime: number;
    turnCount: number;
    totalTokens: number;
    estimatedCost: number;
    status: string;
  };
  onClick: (sessionId: string) => void;
}

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const statusMap: Record<string, { text: string; cls: string }> = {
  recording: { text: '录制中', cls: 'bg-green-500/20 text-green-400' },
  completed: { text: '已完成', cls: 'bg-zinc-600/30 text-zinc-400' },
  error: { text: '错误', cls: 'bg-red-500/20 text-red-400' },
};

export const SessionListItem: React.FC<SessionListItemProps> = ({ session, onClick }) => {
  const st = statusMap[session.status] || statusMap.completed;

  return (
    <button
      onClick={() => onClick(session.id)}
      className="w-full text-left p-3 bg-zinc-800/30 rounded-lg border border-transparent hover:border-zinc-700/50 hover:bg-zinc-800/50 transition-colors"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-zinc-200 truncate max-w-[400px] font-medium">
          {session.title}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${st.cls}`}>
          {st.text}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-zinc-500">
        <span>{session.modelProvider}/{session.modelName}</span>
        <span>{formatTime(session.startTime)}</span>
        <span>{session.turnCount} 轮</span>
        <span>{Math.round(session.totalTokens / 1000)}K tokens</span>
        {session.estimatedCost > 0 && (
          <span>${session.estimatedCost.toFixed(4)}</span>
        )}
      </div>
    </button>
  );
};
