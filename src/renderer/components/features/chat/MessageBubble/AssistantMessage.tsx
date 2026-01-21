// ============================================================================
// AssistantMessage - Display AI assistant messages
// ============================================================================

import React, { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay';
import { formatTime } from './utils';
import { useIsCoworkMode } from '../../../../stores/modeStore';
import { summarizeToolCall } from '../../../../utils/toolSummary';

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  const isCoworkMode = useIsCoworkMode();
  const [showToolDetails, setShowToolDetails] = useState(false);

  // In Cowork mode, create a summary of all tool calls
  const toolCallsSummary = message.toolCalls && message.toolCalls.length > 0
    ? message.toolCalls.map(tc => summarizeToolCall(tc)).join(' → ')
    : null;

  // Count successful/failed tool calls
  const toolStats = message.toolCalls?.reduce(
    (acc, tc) => {
      if (tc.result?.success) acc.success++;
      else if (tc.result?.error) acc.failed++;
      else acc.pending++;
      return acc;
    },
    { success: 0, failed: 0, pending: 0 }
  );

  return (
    <div className="flex gap-3 animate-slideUp">
      {/* Avatar */}
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-lg bg-gradient-to-br from-accent-purple to-accent-pink shadow-purple-500/20">
        <Bot className="w-4 h-4 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Text content */}
        {message.content && (
          <div className="inline-block rounded-2xl px-4 py-3 max-w-full shadow-lg bg-zinc-800/80 text-zinc-100 border border-zinc-700/50 shadow-black/20">
            <MessageContent content={message.content} isUser={false} />
          </div>
        )}

        {/* Tool calls - different display based on mode */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          isCoworkMode ? (
            // Cowork mode: Simplified tool display
            <div className="mt-3">
              <button
                onClick={() => setShowToolDetails(!showToolDetails)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-zinc-700/30 hover:bg-zinc-800/60 transition-colors"
              >
                {showToolDetails ? (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-zinc-500" />
                )}
                <Wrench className="w-3.5 h-3.5 text-zinc-400" />
                <span className="text-sm text-zinc-300 flex-1 text-left truncate">
                  {toolCallsSummary}
                </span>
                {/* Stats badges */}
                <div className="flex items-center gap-1.5">
                  {toolStats && toolStats.success > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded bg-emerald-500/20 text-emerald-400">
                      {toolStats.success}
                    </span>
                  )}
                  {toolStats && toolStats.failed > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded bg-red-500/20 text-red-400">
                      {toolStats.failed}
                    </span>
                  )}
                  {toolStats && toolStats.pending > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400">
                      {toolStats.pending}
                    </span>
                  )}
                </div>
              </button>

              {/* Expanded tool details */}
              {showToolDetails && (
                <div className="mt-2 space-y-2 animate-fadeIn">
                  {message.toolCalls.map((toolCall, index) => (
                    <ToolCallDisplay
                      key={toolCall.id}
                      toolCall={toolCall}
                      index={index}
                      total={message.toolCalls!.length}
                      compact
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            // Developer mode: Full tool display
            <div className="mt-3 space-y-2">
              {message.toolCalls.map((toolCall, index) => (
                <ToolCallDisplay
                  key={toolCall.id}
                  toolCall={toolCall}
                  index={index}
                  total={message.toolCalls!.length}
                />
              ))}
            </div>
          )
        )}

        {/* Timestamp */}
        <div className="text-xs text-zinc-500 mt-1.5">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};
