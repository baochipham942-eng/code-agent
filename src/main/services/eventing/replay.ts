// ============================================================================
// EventReplay — 基于 InternalEventStore 的事件回放
// 原 src/main/events/eventReplay.ts，P0-5 阶段 A 迁入 protocol 层；
// 2026-04-27 从 protocol/events/ 搬到 services/eventing/（runtime class）
// ============================================================================

import { InternalEventStore, StoredEvent } from './internalStore';

export class EventReplay {
  constructor(private store: InternalEventStore) {}

  replay(filter?: { agentId?: string; timeRange?: [number, number] }): StoredEvent[] {
    let events = this.store.readEvents(filter?.agentId ? { agentId: filter.agentId } : undefined);
    if (filter?.timeRange) {
      const [start, end] = filter.timeRange;
      events = events.filter(e => e.timestamp >= start && e.timestamp <= end);
    }
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  getTimeline(): Array<{ timestamp: number; domain: string; type: string; summary: string }> {
    return this.store.readEvents().map(e => ({
      timestamp: e.timestamp,
      domain: e.domain,
      type: e.type,
      summary: `${e.domain}:${e.type}${e.agentId !== 'main' ? ` [${e.agentId}]` : ''}`,
    }));
  }
}
