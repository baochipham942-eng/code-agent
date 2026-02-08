// ============================================================================
// Timeline View - 事件时间线
// ============================================================================

import React from 'react';
import type { TelemetryTimelineEvent } from '@shared/types/telemetry';
import { Wrench, MessageSquare, AlertTriangle, Zap, Info, Play, Square } from 'lucide-react';

interface TimelineViewProps {
  events: TelemetryTimelineEvent[];
}

const EVENT_ICONS: Record<string, React.FC<{ className?: string }>> = {
  turn_start: Play,
  turn_end: Square,
  tool_call_start: Wrench,
  tool_call_end: Wrench,
  message: MessageSquare,
  error: AlertTriangle,
  stream_reasoning: Zap,
  notification: Info,
};

const EVENT_COLORS: Record<string, string> = {
  turn_start: 'text-green-400 bg-green-500/10',
  turn_end: 'text-zinc-400 bg-zinc-500/10',
  tool_call_start: 'text-blue-400 bg-blue-500/10',
  tool_call_end: 'text-blue-400 bg-blue-500/10',
  message: 'text-cyan-400 bg-cyan-500/10',
  error: 'text-red-400 bg-red-500/10',
  stream_reasoning: 'text-purple-400 bg-purple-500/10',
  notification: 'text-amber-400 bg-amber-500/10',
};

export const TimelineView: React.FC<TimelineViewProps> = ({ events }) => {
  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };

  if (events.length === 0) {
    return <div className="text-center text-zinc-500 text-sm py-8">暂无事件数据</div>;
  }

  return (
    <div className="space-y-0.5 overflow-y-auto max-h-[calc(100vh-300px)]">
      {events.map((event, idx) => {
        const Icon = EVENT_ICONS[event.eventType] ?? Info;
        const colorClass = EVENT_COLORS[event.eventType] ?? 'text-zinc-400 bg-zinc-500/10';

        return (
          <div key={event.id || idx} className="flex items-start gap-2 py-1.5">
            {/* Timeline line */}
            <div className="flex flex-col items-center w-6 shrink-0">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center ${colorClass}`}>
                <Icon className="w-3 h-3" />
              </div>
              {idx < events.length - 1 && <div className="w-px h-4 bg-zinc-700/50" />}
            </div>

            {/* Event content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-300 truncate">{event.summary}</span>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {event.durationMs != null && (
                    <span className="text-[10px] text-zinc-500">{event.durationMs}ms</span>
                  )}
                  <span className="text-[10px] text-zinc-600 font-mono">{formatTime(event.timestamp)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
