import { describe, it, expect, beforeEach } from 'vitest';
import { InternalEventStore } from '../../../src/main/services/eventing/internalStore';
import { EventReplay } from '../../../src/main/services/eventing/replay';

describe('EventReplay', () => {
  let store: InternalEventStore;
  let replay: EventReplay;

  beforeEach(() => {
    store = new InternalEventStore();
    replay = new EventReplay(store);

    // Insert events out of timestamp order to verify sorting
    store.writeEvent({ agentId: 'main', domain: 'tool', type: 'execute', data: {}, timestamp: 3000 });
    store.writeEvent({ agentId: 'agent-1', domain: 'agent', type: 'start', data: {}, timestamp: 1000 });
    store.writeEvent({ agentId: 'agent-1', domain: 'tool', type: 'result', data: {}, timestamp: 2000 });
    store.writeEvent({ agentId: 'main', domain: 'session', type: 'open', data: {}, timestamp: 500 });
  });

  // --------------------------------------------------------------------------
  // replay
  // --------------------------------------------------------------------------
  describe('replay', () => {
    it('returns all events sorted by timestamp ascending', () => {
      const events = replay.replay();
      expect(events).toHaveLength(4);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
      }
    });

    it('filters by agentId', () => {
      const events = replay.replay({ agentId: 'agent-1' });
      expect(events).toHaveLength(2);
      expect(events.every(e => e.agentId === 'agent-1')).toBe(true);
    });

    it('filters by timeRange (inclusive on both ends)', () => {
      const events = replay.replay({ timeRange: [1000, 2000] });
      expect(events).toHaveLength(2);
      expect(events.every(e => e.timestamp >= 1000 && e.timestamp <= 2000)).toBe(true);
    });

    it('filters by agentId and timeRange combined', () => {
      const events = replay.replay({ agentId: 'agent-1', timeRange: [1500, 3000] });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('result');
    });
  });

  // --------------------------------------------------------------------------
  // getTimeline
  // --------------------------------------------------------------------------
  describe('getTimeline', () => {
    it('returns formatted entries with timestamp, domain, type, summary', () => {
      const timeline = replay.getTimeline();
      expect(timeline).toHaveLength(4);
      for (const entry of timeline) {
        expect(typeof entry.timestamp).toBe('number');
        expect(typeof entry.domain).toBe('string');
        expect(typeof entry.type).toBe('string');
        expect(typeof entry.summary).toBe('string');
      }
    });

    it('summary has no agentId annotation for "main" agent', () => {
      const timeline = replay.getTimeline();
      const mainEntries = timeline.filter(e => e.summary.includes('tool:execute') || e.summary.includes('session:open'));
      for (const entry of mainEntries) {
        expect(entry.summary).not.toContain('[main]');
      }
    });

    it('summary includes agentId annotation for non-main agents', () => {
      const timeline = replay.getTimeline();
      const agentEntries = timeline.filter(e => e.summary.includes('[agent-1]'));
      expect(agentEntries.length).toBeGreaterThan(0);
    });
  });
});
