// ============================================================================
// AssistantMessage - Claude Code terminal style
// Unified display for both developer and cowork modes
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Copy, Check, FileText } from 'lucide-react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay/index';
import { ToolCallGroup } from './ToolCallDisplay/ToolCallGroup';
import { UI } from '@shared/constants';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<'markdown' | 'plain' | null>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (reasoningRef.current) {
      requestAnimationFrame(() => {
        if (reasoningRef.current) {
          setReasoningHeight(reasoningRef.current.scrollHeight);
        }
      });
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
        await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPACT_FROM, message.id);
      } catch {
        // ignore
      }
    }
  }, [message.id]);

  const handleCopy = useCallback(async (mode: 'markdown' | 'plain') => {
    if (!message.content) return;
    const text = mode === 'markdown'
      ? message.content
      : message.content
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/^`{3}.*\n?/, '').replace(/`{3}$/, ''))
          .replace(/`(.+?)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .trim();
    await navigator.clipboard.writeText(text);
    setCopied(mode);
    setTimeout(() => setCopied(null), UI.COPY_FEEDBACK_DURATION);
  }, [message.content]);

  const reasoningContent = message.thinking || message.reasoning;
  const effortLabel = message.effortLevel || '';

  return (
    <div
      className="py-2 px-4 relative group/msg"
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Copy action bar - top right on hover */}
      {message.content && hovered && (
        <div className="absolute top-1 right-4 flex items-center gap-0.5 bg-zinc-800 border border-zinc-700 rounded-md px-0.5 py-0.5 z-10 shadow-lg">
          <button
            onClick={() => handleCopy('markdown')}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            title="复制 Markdown"
          >
            {copied === 'markdown' ? <Check className="w-3 h-3 text-green-400" /> : <FileText className="w-3 h-3" />}
          </button>
          <button
            onClick={() => handleCopy('plain')}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            title="复制纯文本"
          >
            {copied === 'plain' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      )}

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

      {/* 有 contentParts 时按交错顺序渲染，否则 fallback 到旧逻辑 */}
      {message.contentParts && message.contentParts.length > 0 ? (
        <>
          {message.contentParts.map((part, i) => {
            if (part.type === 'text' && part.text) {
              return (
                <div key={`text-${i}`} className="text-zinc-200 leading-relaxed select-text">
                  <MessageContent content={part.text} isUser={false} />
                </div>
              );
            }
            if (part.type === 'tool_call') {
              const tc = message.toolCalls?.find(t => t.id === part.toolCallId);
              if (tc) {
                return (
                  <ToolCallDisplay
                    key={tc.id}
                    toolCall={tc}
                    index={message.toolCalls!.indexOf(tc)}
                    total={message.toolCalls!.length}
                  />
                );
              }
            }
            return null;
          })}
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
};
