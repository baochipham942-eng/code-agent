import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
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
  const timeline = useAgentPointerStore(useShallow(
    (state) => selectAgentPointerTimelineForSurface(state, surface),
  ));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const currentNowMs = Date.now();
    setNowMs(currentNowMs);

    if (!entry || entry.visibleUntilMs <= currentNowMs) return undefined;

    // 每条 entry 只负责自己的到期通知；替换 entry 时 effect cleanup 会取消旧通知。
    // lastBySurface 不随 TTL 清理，位置仍保留给 idle 态光标。
    const timeout = window.setTimeout(() => {
      setNowMs((previousNowMs) => Math.max(previousNowMs, entry.visibleUntilMs, Date.now()));
    }, entry.visibleUntilMs - currentNowMs);
    return () => window.clearTimeout(timeout);
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
