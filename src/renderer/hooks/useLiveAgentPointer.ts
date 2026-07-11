import { useEffect, useMemo, useState } from 'react';
import type { AgentPointerEvent, AgentPointerSurface } from '@shared/contract';
import {
  selectAgentPointerTimelineForSurface,
  useAgentPointerStore,
  type AgentPointerTimelineEntry,
} from '../stores/agentPointerStore';

export interface LiveAgentPointerState {
  /** TTL 内的活跃事件；过期后为 null（与旧语义一致） */
  event: AgentPointerEvent | null;
  /** 最后一条事件，TTL 过期后仍保留——供光标停留在最后位置淡出为 idle，而非卸载瞬移 */
  lastEvent: AgentPointerEvent | null;
  isLive: boolean;
  timeline: AgentPointerTimelineEntry[];
}

export function useLiveAgentPointer(surface: AgentPointerSurface): LiveAgentPointerState {
  const entry = useAgentPointerStore((state) => state.lastBySurface[surface]);
  const timeline = useAgentPointerStore((state) => selectAgentPointerTimelineForSurface(state, surface));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!entry || entry.visibleUntilMs <= Date.now()) return undefined;
    // 不再 pruneExpired 清掉 lastBySurface——位置要保留给 idle 态光标
    const interval = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [entry]);

  const isLive = Boolean(entry && entry.visibleUntilMs > nowMs);

  const event = useMemo(() => {
    if (!entry || !isLive) {
      return null;
    }
    return entry.event;
  }, [entry, isLive]);

  return { event, lastEvent: entry?.event ?? null, isLive, timeline };
}
