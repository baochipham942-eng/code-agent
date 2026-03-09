// ============================================================================
// SessionListItem - 会话卡片（AgentsView 视觉风格）
// ============================================================================

import React from 'react';

// 状态颜色映射（借鉴 AGENT_COLORS 风格）
const STATUS_STYLES: Record<string, { icon: string; text: string; badge: string; border: string }> = {
  recording: {
    icon: '\u{1F534}',
    text: '录制中',
    badge: 'bg-green-500/20 text-green-400',
    border: 'border-green-500/10',
  },
  completed: {
    icon: '\u2705',
    text: '已完成',
    badge: 'bg-zinc-600/30 text-zinc-400',
    border: 'border-white/[0.04]',
  },
  error: {
    icon: '\u274C',
    text: '错误',
    badge: 'bg-red-500/20 text-red-400',
    border: 'border-red-500/10',
  },
};

// 模型 provider 颜色
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'text-purple-400',
  openai: 'text-emerald-400',
  google: 'text-blue-400',
  zhipu: 'text-cyan-400',
  deepseek: 'text-indigo-400',
  default: 'text-zinc-400',
};

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

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
};

export const SessionListItem: React.FC<SessionListItemProps> = ({ session, onClick }) => {
  const st = STATUS_STYLES[session.status] || STATUS_STYLES.completed;
  const providerColor = PROVIDER_COLORS[session.modelProvider?.toLowerCase()] || PROVIDER_COLORS.default;

  return (
    <button
      onClick={() => onClick(session.id)}
      className={`w-full text-left bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border ${st.border} hover:bg-white/[0.04] hover:border-white/[0.08] transition-all group`}
    >
      {/* Top row: title + status badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-xs text-zinc-200 truncate max-w-[420px] font-medium leading-relaxed group-hover:text-zinc-200 transition">
          {session.title}
        </span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${st.badge}`}>
          {st.icon} {st.text}
        </span>
      </div>

      {/* Model info row */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">{'\u{1F916}'}</span>
        <span className={`text-[11px] font-medium ${providerColor}`}>
          {session.modelProvider}
        </span>
        <span className="text-[11px] text-zinc-500">/</span>
        <span className="text-[11px] text-zinc-400 truncate">
          {session.modelName}
        </span>
      </div>

      {/* Stats row - pill style */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700/60 text-zinc-400">
          {'\u{1F4C5}'} {formatTime(session.startTime)}
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700/60 text-zinc-400">
          {'\u{1F504}'} {session.turnCount} 轮
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700/60 text-zinc-400">
          {'\u{1F4AC}'} {formatTokens(session.totalTokens)} tokens
        </span>
        {session.estimatedCost > 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
            ${session.estimatedCost.toFixed(4)}
          </span>
        )}
      </div>
    </button>
  );
};
