// ============================================================================
// AssistantMessage - Claude Code terminal style
// Unified display for both developer and cowork modes
// ============================================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Copy, Check, FileText, RefreshCw, BarChart3, Table, Code, GitBranch } from 'lucide-react';
import type { AssistantMessageProps } from './types';
import type { Artifact } from '@shared/types/message';
import { MessageContent } from './MessageContent';
import { ToolCallDisplay } from './ToolCallDisplay/index';
import { ToolCallGroupList } from './ToolCallDisplay/ToolCallGroup';
import { UI } from '@shared/constants';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { groupToolCalls, extractThinkingSummary } from '../../../../utils/toolGrouping';

function getArtifactIcon(type: Artifact['type']): React.ReactNode {
  const cls = "w-3 h-3";
  switch (type) {
    case 'chart': return <BarChart3 className={cls} />;
    case 'spreadsheet': return <Table className={cls} />;
    case 'document': return <FileText className={cls} />;
    case 'generative_ui': return <Code className={cls} />;
    case 'mermaid': return <GitBranch className={cls} />;
    default: return <FileText className={cls} />;
  }
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message, onRegenerate }) => {
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
  const thinkingSummary = useMemo(
    () => extractThinkingSummary(reasoningContent),
    [reasoningContent]
  );

  // Smart tool grouping for fallback path
  const toolGroups = useMemo(
    () => message.toolCalls ? groupToolCalls(message.toolCalls) : [],
    [message.toolCalls]
  );

  return (
    <div
      aria-label="助手消息"
      className="py-2 px-4 relative group/msg"
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Action bar - top right on hover */}
      {hovered && (
        <div className="absolute top-1 right-4 flex items-center gap-0.5 bg-zinc-800 border border-zinc-700 rounded-md px-0.5 py-0.5 z-10 shadow-lg">
          {onRegenerate && (
            <button
              onClick={() => message.id && onRegenerate(message.id)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
              title="重新生成"
              aria-label="重新生成"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
          {message.content && (
            <>
              <button
                onClick={() => handleCopy('markdown')}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
                title="复制 Markdown"
                aria-label="复制 Markdown"
              >
                {copied === 'markdown' ? <Check className="w-3 h-3 text-green-400" /> : <FileText className="w-3 h-3" />}
              </button>
              <button
                onClick={() => handleCopy('plain')}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
                title="复制纯文本"
                aria-label="复制纯文本"
              >
                {copied === 'plain' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </>
          )}
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
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors min-w-0"
          >
            <span className="font-mono flex-shrink-0">{showReasoning ? '▼' : '▶'}</span>
            <span className="flex-shrink-0">
              thinking{effortLabel ? ` (${effortLabel})` : ''}
            </span>
            {!showReasoning && thinkingSummary && (
              <span className="text-zinc-600 truncate">
                — {thinkingSummary}
              </span>
            )}
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

      {/* 有 contentParts 时按交错顺序渲染（连续 tool_call 自动分组），否则 fallback */}
      {message.contentParts && message.contentParts.length > 0 ? (
        <ContentPartsRenderer message={message} />
      ) : (
        <>
          {/* Text content */}
          {message.content && (
            <div className="text-zinc-200 leading-relaxed select-text">
              <MessageContent content={message.content} isUser={false} />
            </div>
          )}

          {/* Tool calls - smart grouping with auto-collapse */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 space-y-0">
              <ToolCallGroupList groups={toolGroups} />
            </div>
          )}
        </>
      )}

      {/* Artifacts bar */}
      {message.artifacts && message.artifacts.length > 0 && (
        <div className="mt-2 flex gap-1.5 flex-wrap">
          {message.artifacts.map((artifact) => (
            <span
              key={artifact.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-400 border border-zinc-700"
            >
              {getArtifactIcon(artifact.type)}
              <span>{artifact.title || artifact.type}</span>
              <span className="text-zinc-600">v{artifact.version}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// ContentPartsRenderer - renders contentParts with smart grouping
// Consecutive tool_call parts are grouped using toolGrouping logic
// ============================================================================

import type { Message, ToolCall } from './types';

function ContentPartsRenderer({ message }: { message: Message }) {
  const parts = message.contentParts!;
  const toolCalls = message.toolCalls;

  // Build render segments: merge consecutive tool_call parts into groups
  const segments = useMemo(() => {
    const result: Array<
      | { type: 'text'; text: string; key: string }
      | { type: 'tool_group'; groups: ReturnType<typeof groupToolCalls>; key: string }
    > = [];

    let i = 0;
    while (i < parts.length) {
      const part = parts[i];

      if (part.type === 'text' && part.text) {
        result.push({ type: 'text', text: part.text, key: `text-${i}` });
        i++;
        continue;
      }

      if (part.type === 'tool_call') {
        // Collect consecutive tool_call parts
        const consecutiveToolCalls: ToolCall[] = [];
        while (i < parts.length && parts[i].type === 'tool_call') {
          const p = parts[i];
          if (p.type === 'tool_call') {
            const tc = toolCalls?.find(t => t.id === p.toolCallId);
            if (tc) consecutiveToolCalls.push(tc);
          }
          i++;
        }

        if (consecutiveToolCalls.length > 0) {
          const groups = groupToolCalls(consecutiveToolCalls);
          result.push({
            type: 'tool_group',
            groups,
            key: `tools-${consecutiveToolCalls[0].id}`,
          });
        }
        continue;
      }

      i++;
    }

    return result;
  }, [parts, toolCalls]);

  return (
    <>
      {segments.map(segment => {
        if (segment.type === 'text') {
          return (
            <div key={segment.key} className="text-zinc-200 leading-relaxed select-text">
              <MessageContent content={segment.text} isUser={false} />
            </div>
          );
        }

        return (
          <div key={segment.key} className="space-y-0">
            <ToolCallGroupList groups={segment.groups} />
          </div>
        );
      })}
    </>
  );
}
