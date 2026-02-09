// ============================================================================
// Session Header - 会话遥测头部信息
// ============================================================================

import React from 'react';
import type { TelemetrySession } from '@shared/types/telemetry';
import { Activity, Clock, Cpu, AlertTriangle, CheckCircle } from 'lucide-react';
import { formatDuration } from '../../../../shared/utils/format';

interface SessionHeaderProps {
  session: TelemetrySession;
}

export const SessionHeader: React.FC<SessionHeaderProps> = ({ session }) => {

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  const statusColor = {
    recording: 'bg-green-500',
    completed: 'bg-zinc-500',
    error: 'bg-red-500',
  }[session.status] ?? 'bg-zinc-500';

  return (
    <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${statusColor} ${session.status === 'recording' ? 'animate-pulse' : ''}`} />
        <div>
          <h3 className="text-sm font-medium text-zinc-200 truncate max-w-[300px]">
            {session.title}
          </h3>
          <p className="text-xs text-zinc-500">
            {session.modelProvider}/{session.modelName} · {new Date(session.startTime).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-400">
        <div className="flex items-center gap-1" title="轮次数">
          <Activity className="w-3.5 h-3.5" />
          <span>{session.turnCount}</span>
        </div>
        <div className="flex items-center gap-1" title="总 Token">
          <Cpu className="w-3.5 h-3.5" />
          <span>{formatTokens(session.totalTokens)}</span>
        </div>
        <div className="flex items-center gap-1" title="时长">
          <Clock className="w-3.5 h-3.5" />
          <span>{session.durationMs ? formatDuration(session.durationMs) : '--'}</span>
        </div>
        <div className="flex items-center gap-1" title="工具成功率">
          {session.toolSuccessRate >= 0.8 ? (
            <CheckCircle className="w-3.5 h-3.5 text-green-400" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          )}
          <span>{(session.toolSuccessRate * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
};
