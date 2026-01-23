// ============================================================================
// CoworkMessageBubble - Simplified message display for Cowork mode
// Claude/ChatGPT style: left-aligned, no avatar, no background
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, Check, AlertCircle, Loader2 } from 'lucide-react';
import type { Message } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay/index';
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
 * - Claude/ChatGPT style: no avatar, left-aligned
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
    <div className="py-3 px-4">
      {/* Text content - AI 消息无背景，左对齐 */}
      {message.content && (
        <div className="text-zinc-200 leading-relaxed">
          <MessageContent content={message.content} isUser={false} />
        </div>
      )}

      {/* Tool calls - Collapsed summary view */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-3">
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
    </div>
  );
};

export default CoworkMessageBubble;
