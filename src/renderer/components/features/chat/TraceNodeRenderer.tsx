// ============================================================================
// TraceNodeRenderer - Render individual trace nodes by type
// Reuses existing MessageContent, ToolCallDisplay, UserMessage components
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import type { TraceNode } from '@shared/types/trace';
import type { ToolCall } from '@shared/types';
import { MessageContent } from './MessageBubble/MessageContent';
import { ToolCallDisplay } from './MessageBubble/ToolCallDisplay/index';
import { AttachmentDisplay } from './MessageBubble/AttachmentPreview';
import { ExpandableContent } from './ExpandableContent';
import { Archive, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';

interface TraceNodeRendererProps {
  node: TraceNode;
  /** Message attachments for user nodes */
  attachments?: import('@shared/types').MessageAttachment[];
}

export const TraceNodeRenderer: React.FC<TraceNodeRendererProps> = ({ node, attachments }) => {
  switch (node.type) {
    case 'user':
      return <UserNode content={node.content} attachments={attachments} />;
    case 'assistant_text':
      return <AssistantTextNode node={node} />;
    case 'tool_call':
      return <ToolCallNode node={node} />;
    case 'system':
      return <SystemNode node={node} />;
    default:
      return null;
  }
};

// ---- User Node ----
const UserNode: React.FC<{ content: string; attachments?: import('@shared/types').MessageAttachment[] }> = ({ content, attachments }) => (
  <div className="select-text">
    {attachments && attachments.length > 0 && (
      <div className="mb-2">
        <AttachmentDisplay attachments={attachments} />
      </div>
    )}
    {content && (
      <div
        className="pl-3 border-l-2 rounded-r-lg py-2 pr-3"
        style={{
          borderColor: 'var(--cc-brand)',
          backgroundColor: 'var(--cc-user-bg)',
        }}
      >
        <div className="text-zinc-200 leading-relaxed">
          <MessageContent content={content} isUser={true} />
        </div>
      </div>
    )}
  </div>
);

// ---- Assistant Text Node ----
const AssistantTextNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);

  const reasoningContent = node.thinking || node.reasoning;

  useEffect(() => {
    if (reasoningRef.current) {
      setReasoningHeight(reasoningRef.current.scrollHeight);
    }
  }, [showReasoning, reasoningContent]);

  return (
    <div>
      {/* Thinking/Reasoning fold */}
      {reasoningContent?.trim() && (
        <div className="mb-2">
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
          >
            <span className="font-mono">{showReasoning ? '▼' : '▶'}</span>
            <span>thinking</span>
          </button>
          <div
            ref={reasoningRef}
            className="overflow-hidden transition-all duration-300 ease-out"
            style={{
              maxHeight: showReasoning ? (reasoningHeight ? `${reasoningHeight}px` : '500px') : '0px',
              opacity: showReasoning ? 1 : 0,
            }}
          >
            <div className="mt-1.5 pl-3 border-l border-zinc-700">
              <p className="text-xs text-zinc-500 leading-relaxed whitespace-pre-wrap font-mono">
                {reasoningContent}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Text content */}
      {node.content && (
        <div className="text-zinc-200 leading-relaxed select-text">
          <MessageContent content={node.content} isUser={false} />
        </div>
      )}
    </div>
  );
};

// ---- Tool Call Node ----
const ToolCallNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  if (!node.toolCall) return null;

  // Reconstruct ToolCall object for ToolCallDisplay
  const toolCall: ToolCall = {
    id: node.toolCall.id,
    name: node.toolCall.name,
    arguments: node.toolCall.args,
    _streaming: node.toolCall._streaming,
    result: node.toolCall.result !== undefined ? {
      toolCallId: node.toolCall.id,
      success: node.toolCall.success ?? true,
      output: node.toolCall.success !== false ? node.toolCall.result : undefined,
      error: node.toolCall.success === false ? node.toolCall.result : undefined,
      duration: node.toolCall.duration,
    } : undefined,
  };

  return (
    <ToolCallDisplay
      toolCall={toolCall}
      index={0}
      total={1}
    />
  );
};

// ---- System Node ----
const SystemNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  const [expanded, setExpanded] = useState(false);

  if (node.subtype === 'compaction') {
    return (
      <div className="py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-colors"
        >
          <Archive className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-medium text-amber-300">上下文已压缩</span>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-amber-400 ml-auto" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-amber-400 ml-auto" />
          )}
        </button>
        {expanded && (
          <div className="mt-2 px-3 py-2.5 rounded-md bg-amber-500/5 border border-amber-500/10">
            <ExpandableContent content={node.content} maxLines={30} />
          </div>
        )}
      </div>
    );
  }

  if (node.subtype === 'error') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <span className="text-xs text-red-300">{node.content}</span>
      </div>
    );
  }

  // skill_status or generic system
  return (
    <div className="px-3 py-1.5 text-xs text-zinc-500 italic">
      {node.content}
    </div>
  );
};
