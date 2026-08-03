// ============================================================================
// Session Header - 会话遥测头部信息
// 2026-07-27 评测中心 v2：文案改走 i18n（t.telemetry.header.*），
// 随 EvalTelemetryTab 内嵌进评测中心「遥测」tab。
// ============================================================================

import React from 'react';
import type { TelemetrySession } from '@shared/contract/telemetry';
import { Activity, Clock, Cpu, AlertTriangle, CheckCircle } from 'lucide-react';
import { formatDuration } from '../../../../shared/utils/format';
import { useI18n } from '../../../hooks/useI18n';

interface SessionHeaderProps {
  session: TelemetrySession;
}

export const SessionHeader: React.FC<SessionHeaderProps> = ({ session }) => {
  const { t } = useI18n();
  const h = t.telemetry.header;

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  const statusColor = {
    recording: 'bg-green-500',
    completed: 'bg-zinc-600',
    error: 'bg-red-500',
  }[session.status] ?? 'bg-zinc-600';

  return (
    <div className="flex items-center justify-between p-3 bg-zinc-800 rounded-lg border border-zinc-700">
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
        <div className="flex items-center gap-1" title={h.turns}>
          <Activity className="w-3.5 h-3.5" />
          <span>{session.turnCount}</span>
        </div>
        <div className="flex items-center gap-1" title={h.tokens}>
          <Cpu className="w-3.5 h-3.5" />
          <span>{formatTokens(session.totalTokens)}</span>
        </div>
        <div className="flex items-center gap-1" title={h.duration}>
          <Clock className="w-3.5 h-3.5" />
          <span>{session.durationMs ? formatDuration(session.durationMs) : '--'}</span>
        </div>
        <div className="flex items-center gap-1" title={h.toolSuccessRate}>
          {session.toolSuccessRate >= 0.8 ? (
            <CheckCircle className="w-3.5 h-3.5 text-badge-success" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 text-badge-warning" />
          )}
          <span>{(session.toolSuccessRate * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
};
