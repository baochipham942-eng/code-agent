import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import type { TraceTurn } from '@shared/contract/trace';
import { useI18n } from '../../../hooks/useI18n';
import { sanitizeThinkingForDisplay } from '../../../utils/toolGrouping';

export interface TurnThinkingSegment {
  id: string;
  text: string;
  startedAt: number;
  estimatedEndedAt?: number;
}

/** 收集一轮内全部有效 reasoning 段，继续维持单个合并横幅。 */
export function getTurnThinkingSegments(turn: TraceTurn): TurnThinkingSegment[] {
  const segments: TurnThinkingSegment[] = [];
  for (let index = 0; index < turn.nodes.length; index += 1) {
    const node = turn.nodes[index];
    if (node.type !== 'assistant_text') continue;
    const text = sanitizeThinkingForDisplay(node.thinking || node.reasoning)?.trim();
    if (!text) continue;

    const followingNode = turn.nodes.slice(index + 1).find((candidate) => (
      candidate.type !== 'assistant_text'
      || Boolean(candidate.content?.trim())
    ));
    segments.push({
      id: node.id,
      text,
      startedAt: node.timestamp,
      estimatedEndedAt: followingNode?.timestamp
        ?? (turn.status === 'completed' ? turn.endTime : undefined),
    });
  }
  return segments;
}

export function getHasNonThinkingContentAfterThinking(
  turn: TraceTurn,
  segments: TurnThinkingSegment[],
): boolean {
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return false;
  const segmentIndex = turn.nodes.findIndex((node) => node.id === lastSegment.id);
  if (segmentIndex < 0) return false;
  const segmentNode = turn.nodes[segmentIndex];
  if (segmentNode.type === 'assistant_text' && segmentNode.content?.trim()) return true;
  return turn.nodes.slice(segmentIndex + 1).some((node) => (
    node.type !== 'assistant_text'
    || Boolean(node.content?.trim())
  ));
}

export function isThinkingScrollerPinnedToBottom(
  scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = 2,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface ThinkingDigestBannerProps {
  segments: TurnThinkingSegment[];
  activeSegmentId: string | null;
  hasNonThinkingContentAfterThinking: boolean;
  turnEndTime?: number;
}

export const ThinkingDigestBanner: React.FC<ThinkingDigestBannerProps> = ({
  segments,
  activeSegmentId,
  hasNonThinkingContentAfterThinking,
  turnEndTime,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(Boolean(activeSegmentId));
  const [userInteracted, setUserInteracted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [observedEndedAt, setObservedEndedAt] = useState<Record<string, number>>({});
  const previousActiveSegmentIdRef = useRef(activeSegmentId);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const shouldFollowBottomRef = useRef(true);

  useEffect(() => {
    const previousActiveSegmentId = previousActiveSegmentIdRef.current;
    const timestamp = Date.now();

    if (previousActiveSegmentId && !activeSegmentId && hasNonThinkingContentAfterThinking) {
      setObservedEndedAt((current) => (
        current[previousActiveSegmentId]
          ? current
          : { ...current, [previousActiveSegmentId]: timestamp }
      ));
      setNow(timestamp);
    }

    if (!userInteracted) {
      if (activeSegmentId && activeSegmentId !== previousActiveSegmentId) {
        setExpanded(true);
        shouldFollowBottomRef.current = true;
      } else if (
        previousActiveSegmentId
        && !activeSegmentId
        && hasNonThinkingContentAfterThinking
      ) {
        setExpanded(false);
      }
    }

    previousActiveSegmentIdRef.current = activeSegmentId;
  }, [activeSegmentId, hasNonThinkingContentAfterThinking, userInteracted]);

  useEffect(() => {
    if (!activeSegmentId) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [activeSegmentId]);

  const reasoningTextRevision = segments.map((segment) => segment.text).join('\u0000');
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!expanded || !scroller || !shouldFollowBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [expanded, reasoningTextRevision]);

  if (segments.length === 0) return null;

  const durationMs = segments.reduce((total, segment) => {
    const endedAt = segment.id === activeSegmentId
      ? now
      : observedEndedAt[segment.id] ?? segment.estimatedEndedAt ?? turnEndTime ?? segment.startedAt;
    return total + Math.max(0, endedAt - segment.startedAt);
  }, 0);
  const duration = t.chat.thinkingDurationSeconds.replace(
    '{seconds}',
    String(Math.max(1, Math.ceil(durationMs / 1000))),
  );
  const digestLabel = activeSegmentId
    ? t.chat.thinkingActiveWithDuration.replace('{duration}', duration)
    : t.chat.thinkingDigestWithDuration
      .replace('{duration}', duration)
      .replace('{count}', String(segments.length));

  return (
    <div
      className="py-0.5 text-sm text-zinc-500"
      data-testid="thinking-digest"
      data-user-interacted={userInteracted ? 'true' : 'false'}
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
        onClick={() => {
          setUserInteracted(true);
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        title={expanded ? t.chat.collapseThinking : t.chat.expandThinking}
      >
        <Brain className="h-4 w-4 shrink-0" />
        <span
          className={`min-w-0 truncate font-medium ${activeSegmentId ? 'streaming-thinking-shimmer' : ''}`}
        >
          {digestLabel}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
      </button>
      <div
        className={`thinking-digest-content ${expanded ? 'is-expanded' : ''}`}
        aria-hidden={!expanded}
      >
        <div
          ref={scrollerRef}
          className="thinking-digest-scroller ml-7 mt-1 space-y-2 overflow-y-auto text-[13px] leading-5 text-zinc-500"
          onScroll={(event) => {
            shouldFollowBottomRef.current = isThinkingScrollerPinnedToBottom(event.currentTarget);
          }}
          style={{ scrollBehavior: prefersReducedMotion() ? 'auto' : 'smooth' }}
        >
          {segments.map((segment, index) => (
            <p key={segment.id} className="whitespace-pre-line font-mono">
              {segments.length > 1 ? `${index + 1}. ` : ''}
              {segment.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
};
