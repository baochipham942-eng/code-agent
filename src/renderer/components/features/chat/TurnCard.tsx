// ============================================================================
// TurnCard - A single conversation turn (user prompt + assistant responses)
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TraceTurn } from '@shared/types/trace';
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

export const TurnCard: React.FC<TurnCardProps> = ({ turn, defaultExpanded = false, forceExpanded, highlightActive }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Auto-expand when search matches
  React.useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);

  const stats = useMemo(() => {
    const toolCount = turn.nodes.filter(n => n.type === 'tool_call').length;
    const duration = turn.endTime ? turn.endTime - turn.startTime : null;
    const time = new Date(turn.startTime).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { toolCount, duration, time };
  }, [turn]);

  // Get user message preview for collapsed header
  const userPreview = useMemo(() => {
    const userNode = turn.nodes.find(n => n.type === 'user');
    if (!userNode) return '';
    const text = userNode.content.trim();
    return text.length > 60 ? text.slice(0, 60) + '...' : text;
  }, [turn.nodes]);

  const isStreaming = turn.status === 'streaming';

  return (
    <div className={`border border-zinc-800 rounded-lg mb-2 transition-colors ${
      isStreaming ? 'border-primary-500/30 bg-primary-500/5' :
      highlightActive ? 'border-amber-500/40 bg-amber-500/5' :
      'hover:border-zinc-700'
    }`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-zinc-800/50 rounded-t-lg transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}

        <span className="text-xs font-mono text-zinc-500">Turn {turn.turnNumber}</span>
        <span className="text-xs text-zinc-600">·</span>
        <span className="text-xs text-zinc-500">{stats.time}</span>

        {stats.toolCount > 0 && (
          <>
            <span className="text-xs text-zinc-600">·</span>
            <span className="text-xs text-zinc-500">{stats.toolCount} tools</span>
          </>
        )}

        {stats.duration !== null && stats.duration > 0 && (
          <>
            <span className="text-xs text-zinc-600">·</span>
            <span className="text-xs text-zinc-500">{formatDuration(stats.duration)}</span>
          </>
        )}

        {isStreaming && (
          <>
            <span className="text-xs text-zinc-600">·</span>
            <span className="text-xs text-primary-400 animate-pulse">streaming</span>
          </>
        )}

        {/* Collapsed preview */}
        {!expanded && userPreview && (
          <span className="text-xs text-zinc-600 truncate ml-2 flex-1">{userPreview}</span>
        )}
      </button>

      {/* Content */}
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
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
      )}
    </div>
  );
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
