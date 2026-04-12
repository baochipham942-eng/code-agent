// ============================================================================
// TurnCard - A single conversation turn (user prompt + assistant responses)
// ============================================================================

import React, { useMemo } from 'react';
import type { TraceTurn } from '@shared/contract/trace';
import { TraceNodeRenderer } from './TraceNodeRenderer';
import { StreamingIndicator } from './StreamingIndicator';

interface TurnCardProps {
  turn: TraceTurn;
  defaultExpanded?: boolean;
  /** Force expand for search matches */
  forceExpanded?: boolean;
  /** This turn contains the active search match */
  highlightActive?: boolean;
}

export const TurnCard: React.FC<TurnCardProps> = ({ turn, highlightActive }) => {
  const stats = useMemo(() => {
    const duration = turn.endTime ? turn.endTime - turn.startTime : null;
    const time = new Date(turn.startTime).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { duration, time };
  }, [turn]);

  const isStreaming = turn.status === 'streaming';

  return (
    <div className={`mb-2 transition-colors ${
      highlightActive ? 'bg-amber-500/5' : ''
    }`}>
      {/* Separator */}
      <div className="flex items-center gap-2 py-1.5">
        <div className="h-px flex-1 bg-zinc-800"></div>
        <span className="text-[10px] text-zinc-600 shrink-0">{stats.time}{stats.duration !== null && stats.duration > 0 ? ` · ${formatDuration(stats.duration)}` : ''}</span>
        <div className="h-px flex-1 bg-zinc-800"></div>
      </div>

      {/* Content - always expanded */}
      <div className={`space-y-2 ${
        isStreaming ? 'border-l-2 border-primary-500/30 pl-2' : ''
      }`}>
        {turn.nodes.map((node, i) => (
          <TraceNodeRenderer
            key={node.id}
            node={node}
            attachments={node.attachments}
            isStreaming={isStreaming && i === turn.nodes.length - 1}
          />
        ))}

        {/* Streaming indicator at bottom of active turn */}
        {isStreaming && turn.nodes.length > 0 && (
          <StreamingIndicator startTime={turn.startTime} />
        )}
      </div>
    </div>
  );
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
