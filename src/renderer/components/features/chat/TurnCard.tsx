// ============================================================================
// TurnCard - A single conversation turn (user prompt + assistant responses)
// ============================================================================

import React, { useMemo, useState } from 'react';
import type { TraceTurn, TraceNode } from '@shared/contract/trace';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { TraceNodeRenderer } from './TraceNodeRenderer';
import { StreamingIndicator } from './StreamingIndicator';
import { TurnDiffSummary } from './MessageBubble/TurnDiffSummary';
import { ToolStepGroup } from './ToolStepGroup';
import {
  groupAdjacentToolCalls,
  formatTurnDuration,
} from '../../../utils/toolStepGrouping';

interface TurnCardProps {
  turn: TraceTurn;
  defaultExpanded?: boolean;
  /** Force expand for search matches */
  forceExpanded?: boolean;
  /** This turn contains the active search match */
  highlightActive?: boolean;
}

// 超过该节点数的已完成 turn 默认折叠成 "Worked for Xm Ys"
const FOLD_THRESHOLD = 5;

export const TurnCard: React.FC<TurnCardProps> = ({
  turn,
  defaultExpanded,
  forceExpanded,
  highlightActive,
}) => {
  const stats = useMemo(() => {
    const duration = turn.endTime ? turn.endTime - turn.startTime : null;
    const time = new Date(turn.startTime).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { duration, time };
  }, [turn]);

  const isStreaming = turn.status === 'streaming';

  // 把相邻的非 Edit/Write 工具调用聚合成 tool_group
  const displayNodes = useMemo(
    () => groupAdjacentToolCalls(turn.nodes),
    [turn.nodes]
  );

  // 折叠策略：已完成 + 非 streaming + 节点数达阈值 + 父层没说默认展开
  const canFold =
    turn.status === 'completed' &&
    !isStreaming &&
    turn.nodes.length >= FOLD_THRESHOLD;
  const [userExpanded, setUserExpanded] = useState(
    Boolean(defaultExpanded) || !canFold
  );
  const expanded = userExpanded || Boolean(forceExpanded);
  const folded = canFold && !expanded;

  // Codex 式外壳：user 消息 + "Worked for Xm Ys" 折叠/展开按钮 + 最终 AI 结论
  // 中间的 thinking/tool_groups/中间 AI 文本根据 expanded 切换显示
  const foldedView = useMemo(() => {
    if (!canFold) return null;
    const userNode = turn.nodes.find((n) => n.type === 'user') || null;
    const finalTextNode =
      [...turn.nodes]
        .reverse()
        .find(
          (n) =>
            n.type === 'assistant_text' &&
            typeof n.content === 'string' &&
            n.content.trim().length > 0
        ) || null;
    return { userNode, finalTextNode };
  }, [canFold, turn.nodes]);

  const lastIndex = displayNodes.length - 1;

  return (
    <div
      className={`mb-2 transition-colors ${
        highlightActive ? 'bg-amber-500/5' : ''
      }`}
    >
      {/* Separator */}
      <div className="flex items-center gap-2 py-1.5">
        <div className="h-px flex-1 bg-zinc-800"></div>
        <span className="text-[10px] text-zinc-600 shrink-0">
          {stats.time}
          {stats.duration !== null && stats.duration > 0
            ? ` · ${formatTurnDuration(stats.duration)}`
            : ''}
        </span>
        <div className="h-px flex-1 bg-zinc-800"></div>
      </div>

      {/* Content */}
      <div
        className={`space-y-2 ${
          isStreaming ? 'border-l-2 border-primary-500/30 pl-2' : ''
        }`}
      >
        {/* User message always at top */}
        {foldedView?.userNode && (
          <TraceNodeRenderer
            node={foldedView.userNode}
            attachments={foldedView.userNode.attachments}
          />
        )}

        {/* "Worked for Xm Ys" toggle — always visible when foldable */}
        {canFold && (
          <button
            onClick={() => setUserExpanded(!expanded)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-0.5"
            aria-expanded={expanded}
            title={expanded ? '折叠本轮' : '展开本轮'}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-600" />
            ) : (
              <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-600" />
            )}
            <span>
              Worked for{' '}
              {stats.duration ? formatTurnDuration(stats.duration) : '—'}
            </span>
          </button>
        )}

        {/* Middle content (folded: hide; expanded: show all except user) */}
        {!folded && (
          <>
            {displayNodes.map((d, i) => {
              if (d.kind === 'tool_group') {
                return (
                  <ToolStepGroup
                    key={d.key}
                    nodes={d.tools}
                    defaultExpanded={isStreaming}
                  />
                );
              }
              const node: TraceNode = d.node;
              // User node rendered above; skip here to avoid duplicate
              if (canFold && foldedView?.userNode && node.id === foldedView.userNode.id) {
                return null;
              }
              // Final text rendered below; skip here to avoid duplicate
              if (canFold && foldedView?.finalTextNode && node.id === foldedView.finalTextNode.id) {
                return null;
              }
              const isNodeStreaming =
                isStreaming && i === lastIndex && node.type === 'assistant_text';
              return (
                <TraceNodeRenderer
                  key={node.id}
                  node={node}
                  attachments={node.attachments}
                  isStreaming={isNodeStreaming}
                />
              );
            })}

            {/* Streaming indicator at bottom of active turn */}
            {isStreaming && turn.nodes.length > 0 && (
              <StreamingIndicator startTime={turn.startTime} />
            )}
          </>
        )}

        {/* Final AI answer (always shown when foldable; non-foldable turns already rendered in map above) */}
        {canFold && foldedView?.finalTextNode && (
          <TraceNodeRenderer
            node={foldedView.finalTextNode}
            attachments={foldedView.finalTextNode.attachments}
          />
        )}

        {/* Turn-level aggregated diff card — always visible */}
        <TurnDiffSummary turn={turn} />
      </div>
    </div>
  );
};
