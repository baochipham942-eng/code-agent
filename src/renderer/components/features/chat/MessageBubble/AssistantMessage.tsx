// ============================================================================
// AssistantMessage - Claude Code terminal style
// Unified display for both developer and cowork modes
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay/index';
import { ToolCallGroup } from './ToolCallDisplay/ToolCallGroup';
import { UI } from '@shared/constants';
import { IPC_CHANNELS } from '@shared/ipc';

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (reasoningRef.current) {
      setReasoningHeight(reasoningRef.current.scrollHeight);
    }
  }, [showReasoning, message.reasoning]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCompactFrom = useCallback(async () => {
    setContextMenu(null);
    if (message.id) {
      try {
        await window.electronAPI?.invoke(IPC_CHANNELS.CONTEXT_COMPACT_FROM, message.id);
      } catch {
        // ignore
      }
    }
  }, [message.id]);

  const reasoningContent = message.thinking || message.reasoning;
  const effortLabel = message.effortLevel || '';

  return (
    <div className="py-2 px-4" onContextMenu={handleContextMenu}>
      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-zinc-700 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleCompactFrom}
            className="w-full px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-600 transition-colors"
          >
            Compact from here
          </button>
        </div>
      )}
      {/* Thinking/Reasoning - simplified plain text fold */}
      {reasoningContent?.trim() && (
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
            <div className="mt-1.5 pl-3 border-l border-zinc-700">
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
          {message.toolCalls.length >= UI.TOOL_GROUP_THRESHOLD ? (
            <ToolCallGroup toolCalls={message.toolCalls} startIndex={0} />
          ) : (
            message.toolCalls.map((toolCall, index) => (
              <ToolCallDisplay
                key={toolCall.id}
                toolCall={toolCall}
                index={index}
                total={message.toolCalls!.length}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};
