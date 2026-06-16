// ============================================================================
// AssistantMessage - Claude Code terminal style
// Unified display for both developer and cowork modes
// ============================================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Copy, Check, FileText, RefreshCw, RotateCcw, ThumbsUp, ThumbsDown } from 'lucide-react';
import type { AssistantMessageProps } from './types';
import { MessageContent } from './MessageContent';
import { ToolCallGroupList } from './ToolCallDisplay/ToolCallGroup';
import { UI } from '@shared/constants';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';
import { groupToolCalls, sanitizeThinkingForDisplay } from '../../../../utils/toolGrouping';
import {
  buildMessageArtifactDeliverableCards,
  buildPendingImageDeliverableCards,
} from '../../../../utils/deliverables';
import { DeliverableCardList } from './DeliverableCardList';

function formatTokenCount(count: number): string {
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
  return String(count);
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message, onRegenerate, onForkFromHere }) => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<'markdown' | 'plain' | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<1 | -1 | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [hovered, setHovered] = useState(false);
  // 带工具调用的回答（绝大多数）也应能反馈：只要有文本结论且属于当前会话即可，
  // 不再因为这一轮含工具执行就隐藏点赞/点踩。
  const canSubmitFeedback = Boolean(
    currentSessionId &&
    message.id &&
    message.content?.trim(),
  );
  const rawReasoningContent = message.thinking || message.reasoning;
  const reasoningContent = useMemo(
    () => sanitizeThinkingForDisplay(rawReasoningContent),
    [rawReasoningContent],
  );

  useEffect(() => {
    if (!showReasoning) {
      setReasoningHeight(null);
      return;
    }
    if (reasoningRef.current) {
      requestAnimationFrame(() => {
        if (reasoningRef.current) {
          setReasoningHeight(reasoningRef.current.scrollHeight);
        }
      });
    }
  }, [showReasoning, reasoningContent]);

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

  const handleFeedback = useCallback(async (rating: 1 | -1) => {
    if (!currentSessionId || !message.id || feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    setFeedbackRating(rating);
    try {
      await ipcService.invoke(IPC_CHANNELS.TELEMETRY_SUBMIT_FEEDBACK, {
        sessionId: currentSessionId,
        turnId: message.id,
        messageId: message.id,
        rating,
        fullContent: rating === -1
          ? {
              messageId: message.id,
              assistantResponse: message.content,
              inputTokens: message.inputTokens,
              outputTokens: message.outputTokens,
            }
          : undefined,
      });
    } catch {
      setFeedbackRating(null);
    } finally {
      setFeedbackSubmitting(false);
    }
  }, [currentSessionId, feedbackSubmitting, message.content, message.id, message.inputTokens, message.outputTokens]);

  const effortLabel = message.effortLevel || '';

  // Smart tool grouping for fallback path
  const toolGroups = useMemo(
    () => message.toolCalls ? groupToolCalls(message.toolCalls) : [],
    [message.toolCalls]
  );
  const artifactCards = useMemo(
    () => [
      ...buildPendingImageDeliverableCards(message),
      ...buildMessageArtifactDeliverableCards(message),
    ],
    [message],
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
          {onForkFromHere && message.id && (
            <button
              onClick={() => onForkFromHere(message.id)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
              title="从此重试"
              aria-label="从此重试"
            >
              <RotateCcw className="w-3 h-3" />
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
            type="button"
            onClick={() => setShowReasoning(!showReasoning)}
            aria-expanded={showReasoning}
            title={showReasoning ? '收起 thinking' : '展开 thinking'}
            className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm py-0.5 text-left text-xs text-zinc-500 transition-colors hover:text-zinc-400"
          >
            <span className="font-mono flex-shrink-0">{showReasoning ? '▼' : '▶'}</span>
            <span className="flex-shrink-0">
              thinking{effortLabel ? ` (${effortLabel})` : ''}
            </span>
          </button>
          <div
            ref={reasoningRef}
            aria-hidden={!showReasoning}
            className="overflow-hidden transition-all duration-300 ease-out"
            style={{
              maxHeight: showReasoning ? (reasoningHeight ? `${reasoningHeight}px` : '500px') : '0px',
              opacity: showReasoning ? 1 : 0,
            }}
          >
            {showReasoning && (
              <div className="mt-1.5 rounded-md border border-white/[0.04] bg-black/10 px-3 py-2">
                <p className="text-xs text-zinc-500 leading-5 whitespace-pre-line font-mono">
                  {reasoningContent}
                </p>
              </div>
            )}
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
              <MessageContent
                content={message.content}
                isUser={false}
                messageId={message.id}
                mediaContext={{ sessionId: currentSessionId || undefined, messageId: message.id }}
              />
            </div>
          )}

          {/* Tool calls - smart grouping with auto-collapse */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 space-y-0">
              <ToolCallGroupList
                groups={toolGroups}
                mediaContext={{ sessionId: currentSessionId || undefined, messageId: message.id }}
              />
            </div>
          )}
        </>
      )}

      {canSubmitFeedback && (
        <div className="mt-2 flex items-center justify-start gap-1">
          <button
            onClick={() => handleFeedback(1)}
            disabled={feedbackSubmitting}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
              feedbackRating === 1
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300'
            }`}
            title="标记有帮助"
            aria-label="标记有帮助"
            aria-pressed={feedbackRating === 1}
          >
            <ThumbsUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handleFeedback(-1)}
            disabled={feedbackSubmitting}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
              feedbackRating === -1
                ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
                : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300'
            }`}
            title="标记有问题"
            aria-label="标记有问题"
            aria-pressed={feedbackRating === -1}
          >
            <ThumbsDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <DeliverableCardList cards={artifactCards} />

      {/* Token usage badge */}
      {(message.inputTokens || message.outputTokens) && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-600">
          {message.inputTokens && (
            <span title="输入 tokens">↓{formatTokenCount(message.inputTokens)}</span>
          )}
          {message.outputTokens && (
            <span title="输出 tokens">↑{formatTokenCount(message.outputTokens)}</span>
          )}
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
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
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
              <MessageContent
                content={segment.text}
                isUser={false}
                messageId={message.id}
                mediaContext={{ sessionId: currentSessionId || undefined, messageId: message.id }}
              />
            </div>
          );
        }

        return (
          <div key={segment.key} className="space-y-0">
            <ToolCallGroupList
              groups={segment.groups}
              mediaContext={{ sessionId: currentSessionId || undefined, messageId: message.id }}
            />
          </div>
        );
      })}
    </>
  );
}
