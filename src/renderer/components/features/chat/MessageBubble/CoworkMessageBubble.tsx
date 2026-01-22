// ============================================================================
// CoworkMessageBubble - Simplified message display for Cowork mode
// ============================================================================

import React, { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Wrench, Check, AlertCircle, Loader2 } from 'lucide-react';
import type { Message } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay';
import { formatTime } from './utils';
import { summarizeToolCall } from '../../../../utils/toolSummary';

interface CoworkMessageBubbleProps {
  message: Message;
}

/**
 * CoworkMessageBubble - A simplified message bubble for Cowork mode
 *
 * Key differences from Developer mode (AssistantMessage):
 * - Tool calls are collapsed by default with a summary view
 * - Thought processes are hidden (no ThoughtDisplay)
 * - More compact layout optimized for end-user experience
 * - Focus on results rather than implementation details
 */
export const CoworkMessageBubble: React.FC<CoworkMessageBubbleProps> = ({ message }) => {
  const [showToolDetails, setShowToolDetails] = useState(false);

  // Generate summary of all tool calls
  const toolCallsSummary = message.toolCalls && message.toolCalls.length > 0
    ? message.toolCalls.map(tc => summarizeToolCall(tc)).join(' -> ')
    : null;

  // Count tool call statuses
  const toolStats = message.toolCalls?.reduce(
    (acc, tc) => {
      if (tc.result?.success) acc.success++;
      else if (tc.result?.error) acc.failed++;
      else acc.pending++;
      return acc;
    },
    { success: 0, failed: 0, pending: 0 }
  );

  // Determine overall status
  const getOverallStatus = () => {
    if (!toolStats) return null;
    if (toolStats.pending > 0) return 'pending';
    if (toolStats.failed > 0) return 'error';
    return 'success';
  };

  const overallStatus = getOverallStatus();

  return (
    <div className="flex gap-3 animate-slideUp">
      {/* Avatar - Compact version */}
      <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-accent-purple to-accent-pink">
        <Bot className="w-3 h-3 text-white" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Text content */}
        {message.content && (
          <div className="inline-block rounded-2xl rounded-tl-md px-4 py-2.5 max-w-[90%] bg-zinc-800/60 text-zinc-100 border border-zinc-700/30">
            <MessageContent content={message.content} isUser={false} />
          </div>
        )}

        {/* Tool calls - Collapsed summary view */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2">
            {/* Summary bar - always visible */}
            <button
              onClick={() => setShowToolDetails(!showToolDetails)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/30 border border-zinc-700/20 hover:bg-zinc-800/50 transition-colors group"
            >
              {/* Expand/collapse icon */}
              {showToolDetails ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-400" />
              )}

              {/* Tool icon */}
              <Wrench className="w-3 h-3 text-zinc-500" />

              {/* Summary text */}
              <span className="text-xs text-zinc-400 flex-1 text-left truncate">
                {message.toolCalls.length === 1
                  ? toolCallsSummary
                  : `${message.toolCalls.length} actions`}
              </span>

              {/* Status indicator */}
              <div className="flex items-center gap-1.5">
                {overallStatus === 'success' && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded bg-emerald-500/15 text-emerald-400">
                    <Check className="w-2.5 h-2.5" />
                    {toolStats!.success > 1 && <span>{toolStats!.success}</span>}
                  </span>
                )}
                {overallStatus === 'error' && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded bg-red-500/15 text-red-400">
                    <AlertCircle className="w-2.5 h-2.5" />
                    {toolStats!.failed > 1 && <span>{toolStats!.failed}</span>}
                  </span>
                )}
                {overallStatus === 'pending' && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded bg-amber-500/15 text-amber-400">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    {toolStats!.pending > 1 && <span>{toolStats!.pending}</span>}
                  </span>
                )}
              </div>
            </button>

            {/* Expanded tool details - compact mode */}
            {showToolDetails && (
              <div className="mt-1.5 space-y-1.5 animate-fadeIn pl-3 border-l-2 border-zinc-700/30">
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
        )}

        {/* Timestamp - smaller in Cowork mode */}
        <div className="text-2xs text-zinc-600 mt-1 ml-1">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};

export default CoworkMessageBubble;
