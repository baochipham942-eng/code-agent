import React from 'react';
import type {
  AgentPointerEvent,
  AgentPointerPhase,
  AgentPointerPoint,
  AgentPointerTone,
} from '@shared/contract';
import { getAgentPointerLabel } from '../../utils/agentPointer';
import type { AgentPointerTimelineEntry } from '../../stores/agentPointerStore';

// ds-allow:start agent 指针可视化色板（SVG 字面色，按模式区分，非 UI token 场景）
const TONE_COLORS: Record<AgentPointerTone, {
  spine: string;
  tip: string;
  glow: string;
  ring: string;
}> = {
  idle: {
    spine: '#14B8A6',
    tip: '#5EEAD4',
    glow: 'rgba(20, 184, 166, 0.28)',
    ring: 'rgba(94, 234, 212, 0.85)',
  },
  browser: {
    spine: '#38BDF8',
    tip: '#7DD3FC',
    glow: 'rgba(56, 189, 248, 0.28)',
    ring: 'rgba(125, 211, 252, 0.85)',
  },
  computer: {
    spine: '#34D399',
    tip: '#6EE7B7',
    glow: 'rgba(52, 211, 153, 0.28)',
    ring: 'rgba(110, 231, 183, 0.85)',
  },
  blocked: {
    spine: '#F87171',
    tip: '#FCA5A5',
    glow: 'rgba(248, 113, 113, 0.28)',
    ring: 'rgba(252, 165, 165, 0.85)',
  },
};
// ds-allow:end

function pointerPosition(point: AgentPointerPoint | null | undefined): React.CSSProperties {
  if (!point) {
    return { left: '42%', top: '40%' };
  }
  if (point.unit === 'percent') {
    return {
      left: `${point.x}%`,
      top: `${point.y}%`,
    };
  }
  return {
    left: `clamp(20px, ${Math.round(point.x)}px, calc(100% - 20px))`,
    top: `clamp(20px, ${Math.round(point.y)}px, calc(100% - 20px))`,
  };
}

function phaseText(phase: AgentPointerPhase): string {
  switch (phase) {
    case 'click':
      return 'click';
    case 'drag':
      return 'drag';
    case 'type':
      return 'input';
    case 'scroll':
      return 'scroll';
    case 'move':
      return 'move';
    case 'read':
      return 'observe';
    case 'failed':
    case 'blocked':
      return 'blocked';
    default:
      return 'target';
  }
}

export function AgentPointerGlyph({
  tone = 'idle',
  phase = 'preview',
  size = 18,
  className = '',
}: {
  tone?: AgentPointerTone;
  phase?: AgentPointerPhase;
  size?: number;
  className?: string;
}) {
  const colors = TONE_COLORS[tone];
  const compressed = phase === 'click' || phase === 'failed';
  return (
    <svg
      width={size}
      height={Math.round(size * 1.14)}
      viewBox="0 0 56 64"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{
        filter: `drop-shadow(0 5px 10px rgba(0,0,0,0.36)) drop-shadow(0 0 7px ${colors.glow})`,
        transform: compressed ? 'scale(0.96)' : undefined,
      }}
    >
      {/* ds-allow:start SVG 指针图标字面色（viz） */}
      <path
        d="M9.4 6.4L46.4 36.9L30.6 40.2L39.6 56.5L30.9 61.3L21.8 44.5L11.1 56.8L9.4 6.4Z"
        fill="#09100F"
        stroke="rgba(240, 253, 250, 0.9)"
        strokeWidth="2.3"
        strokeLinejoin="round"
      />
      {/* ds-allow:end */}
      <path
        d="M16.1 16.4L36.8 34.0L24.8 36.7"
        stroke={colors.spine}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.9" cy="8.8" r="2.4" fill={colors.tip} />
    </svg>
  );
}

export function AgentPointerOverlay({
  event,
  showLabel = true,
  compact = false,
}: {
  event: AgentPointerEvent;
  showLabel?: boolean;
  compact?: boolean;
}) {
  const colors = TONE_COLORS[event.tone];
  const label = getAgentPointerLabel(event);
  const size = compact ? 22 : 34;
  const shouldRing = event.phase === 'click' || event.phase === 'failed' || event.phase === 'blocked';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-label={label}>
      {shouldRing && (
        <span
          className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border"
          style={{
            ...pointerPosition(event.point),
            borderColor: colors.ring,
          }}
        />
      )}
      <div
        className="absolute flex items-start gap-2"
        style={{
          ...pointerPosition(event.point),
          transform: 'translate(-8px, -8px)',
        }}
      >
        <AgentPointerGlyph tone={event.tone} phase={event.phase} size={size} />
        {showLabel && (
          <span className="mt-1 max-w-[240px] truncate rounded-md border border-white/[0.08] bg-zinc-950/85 px-2 py-1 text-[11px] font-medium text-zinc-100 shadow-lg backdrop-blur-xs">
            {phaseText(event.phase)}
            {event.targetLabel ? <span className="text-zinc-400"> · {event.targetLabel}</span> : null}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentPointerPreviewCard({
  event,
  title = 'Agent pointer',
  detail,
}: {
  event: AgentPointerEvent;
  title?: string;
  detail?: string;
}) {
  return (
    <div className="relative min-h-[152px] overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-950/70">
      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.05)_0%,rgba(255,255,255,0.015)_42%,rgba(20,184,166,0.06)_100%)]" />
      <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="relative z-10 flex items-center justify-between px-3 pt-3 text-[11px]">
        <span className="font-medium text-zinc-300">{title}</span>
        <span className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-0.5 text-zinc-500">
          {event.surface}
        </span>
      </div>
      {detail && (
        <div className="relative z-10 mt-1 px-3 text-[11px] text-zinc-500">{detail}</div>
      )}
      <AgentPointerOverlay event={event} compact />
    </div>
  );
}

function formatPointerTime(entry: AgentPointerTimelineEntry): string {
  const value = entry.event.completedAtMs || entry.event.occurredAtMs || entry.receivedAtMs;
  if (!value || !Number.isFinite(value)) return '';
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function AgentPointerTimelineList({
  entries,
  title = 'Pointer timeline',
}: {
  entries: AgentPointerTimelineEntry[];
  title?: string;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="rounded-lg border border-white/[0.08] bg-zinc-950/40">
      <div className="border-b border-white/[0.06] px-3 py-2 text-[11px] font-medium text-zinc-400">
        {title}
      </div>
      <div className="divide-y divide-white/[0.06]">
        {entries.map((entry) => (
          <div key={`${entry.event.id}-${entry.receivedAtMs}`} className="grid grid-cols-[54px_22px_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-[11px]">
            <span className="font-mono text-zinc-600">{formatPointerTime(entry)}</span>
            <AgentPointerGlyph tone={entry.event.tone} phase={entry.event.phase} size={14} />
            <span className="truncate text-zinc-300" title={getAgentPointerLabel(entry.event)}>
              {phaseText(entry.event.phase)}
              {entry.event.targetLabel ? <span className="text-zinc-500"> · {entry.event.targetLabel}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
