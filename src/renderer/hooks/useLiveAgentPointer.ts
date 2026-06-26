import { useEffect, useMemo, useState } from 'react';
import type { AgentPointerEvent, AgentPointerSurface } from '@shared/contract';
import {
  selectAgentPointerTimelineForSurface,
  useAgentPointerStore,
  type AgentPointerTimelineEntry,
} from '../stores/agentPointerStore';

export interface LiveAgentPointerState {
  event: AgentPointerEvent | null;
  timeline: AgentPointerTimelineEntry[];
}

export function useLiveAgentPointer(surface: AgentPointerSurface): LiveAgentPointerState {
  const entry = useAgentPointerStore((state) => state.lastBySurface[surface]);
  const timeline = useAgentPointerStore((state) => selectAgentPointerTimelineForSurface(state, surface));
  const pruneExpired = useAgentPointerStore((state) => state.pruneExpired);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!entry) return undefined;
    const interval = window.setInterval(() => {
      const nextNow = Date.now();
      setNowMs(nextNow);
      pruneExpired(nextNow);
    }, 500);
    return () => window.clearInterval(interval);
  }, [entry, pruneExpired]);

  const event = useMemo(() => {
    if (!entry || entry.visibleUntilMs <= nowMs) {
      return null;
    }
    return entry.event;
  }, [entry, nowMs]);

  return { event, timeline };
}
