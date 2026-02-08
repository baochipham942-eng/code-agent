// ============================================================================
// AssistantMessage - Claude Code terminal style
// Unified display for both developer and cowork modes
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay/index';

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);

  useEffect(() => {
    if (reasoningRef.current) {
      setReasoningHeight(reasoningRef.current.scrollHeight);
    }
  }, [showReasoning, message.reasoning]);

  const reasoningContent = message.thinking || message.reasoning;
  const effortLabel = message.effortLevel || '';

  return (
    <div className="py-2 px-4">
      {/* Thinking/Reasoning - simplified plain text fold */}
      {reasoningContent && (
        <div className="mb-2">
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
          >
            <span className="font-mono">{showReasoning ? '▼' : '▶'}</span>
            <span>
              thinking{effortLabel ? ` (${effortLabel})` : ''}
            </span>
          </button>
          <div
            ref={reasoningRef}
            className="overflow-hidden transition-all duration-300 ease-out"
            style={{
              maxHeight: showReasoning ? (reasoningHeight ? `${reasoningHeight}px` : '500px') : '0px',
              opacity: showReasoning ? 1 : 0,
            }}
          >
            <div className="mt-1.5 pl-3 border-l border-zinc-700/50">
              <p className="text-xs text-zinc-500 leading-relaxed whitespace-pre-wrap font-mono">
                {reasoningContent}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Text content */}
      {message.content && (
        <div className="text-zinc-200 leading-relaxed select-text">
          <MessageContent content={message.content} isUser={false} />
        </div>
      )}

      {/* Tool calls - terminal style, no spacing between items */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-2 space-y-0">
          {message.toolCalls.map((toolCall, index) => (
            <ToolCallDisplay
              key={toolCall.id}
              toolCall={toolCall}
              index={index}
              total={message.toolCalls!.length}
            />
          ))}
        </div>
      )}
    </div>
  );
};
