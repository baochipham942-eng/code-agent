// ============================================================================
// TurnTimeline - Turn-by-Turn 可展开卡片列表（对标 SpreadsheetBench Viewer）
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';

interface EventSummary {
  eventStats: Record<string, number>;
  toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
  thinkingContent: string[];
  errorEvents: Array<{ type: string; message: string }>;
  timeline: Array<{ time: number; type: string; summary: string }>;
}

interface TurnTimelineProps {
  eventSummary: EventSummary | null;
  sessionId: string;
}

const MAX_VISIBLE = 5;

export const TurnTimeline: React.FC<TurnTimelineProps> = ({ eventSummary, sessionId }) => {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);

  if (!eventSummary || eventSummary.timeline.length === 0) return null;

  const timeline = eventSummary.timeline;
  const toolCalls = eventSummary.toolCalls;
  const visible = showAll ? timeline : timeline.slice(0, MAX_VISIBLE);

  const toggleTurn = (idx: number) => {
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <CollapsibleSection title="执行轨迹" defaultOpen={false}>
      <div className="space-y-1.5">
        {visible.map((item, idx) => {
          const isExpanded = expandedTurns.has(idx);
          const time = new Date(item.time).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          // Find matching tool call for this timeline entry
          const toolCall = toolCalls[idx];
          const toolName = toolCall?.name || item.type;
          const success = toolCall?.success;

          return (
            <div key={idx} className="bg-zinc-800/30 rounded-lg border border-zinc-700/20">
              <button
                onClick={() => toggleTurn(idx)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
              >
                <span className="text-[10px] text-zinc-500 font-mono shrink-0">
                  Turn {idx + 1}
                </span>
                <span className="text-[10px] text-zinc-600">{time}</span>
                <span className="text-[11px] text-zinc-300 font-medium truncate">
                  {toolName}
                </span>
                {success !== undefined && (
                  <span className={`text-[10px] ${success ? 'text-green-500' : 'text-red-500'}`}>
                    {success ? '●' : '●'}
                  </span>
                )}
                {toolCall?.duration !== undefined && (
                  <span className="text-[10px] text-zinc-600">
                    {toolCall.duration}ms
                  </span>
                )}
                <ChevronDown
                  className={`w-3 h-3 text-zinc-600 ml-auto shrink-0 transition-transform ${
                    isExpanded ? '' : '-rotate-90'
                  }`}
                />
              </button>
              {isExpanded && (
                <div className="px-3 pb-2 text-[11px] text-zinc-500 border-t border-zinc-700/20 pt-1.5">
                  {item.summary}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!showAll && timeline.length > MAX_VISIBLE && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-2 text-[11px] text-amber-500 hover:text-amber-400 transition"
        >
          查看完整 {timeline.length} 轮 →
        </button>
      )}
    </CollapsibleSection>
  );
};
