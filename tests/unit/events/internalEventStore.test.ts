import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  InternalEventStore,
  resetInternalEventStore,
} from '../../../src/main/services/eventing/internalStore';

describe('InternalEventStore', () => {
  let store: InternalEventStore;

  beforeEach(() => {
    store = new InternalEventStore();
    resetInternalEventStore();
  });

  const makeEvent = (overrides: Partial<{ agentId: string; domain: string; type: string; data: unknown; timestamp: number }> = {}) => ({
    agentId: 'main',
    domain: 'tool',
    type: 'execute',
    data: { tool: 'read' },
    timestamp: Date.now(),
    ...overrides,
  });

  // --------------------------------------------------------------------------
  // writeEvent
  // --------------------------------------------------------------------------
  describe('writeEvent', () => {
    it('returns an eventId string', () => {
      const id = store.writeEvent(makeEvent());
      expect(typeof id).toBe('string');
      expect(id.startsWith('evt-')).toBe(true);
    });

    it('stores the event so readEvents can retrieve it', () => {
      store.writeEvent(makeEvent({ type: 'run' }));
      const events = store.readEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run');
    });
  });

  // --------------------------------------------------------------------------
  // readEvents
  // --------------------------------------------------------------------------
  describe('readEvents', () => {
    beforeEach(() => {
      store.writeEvent(makeEvent({ domain: 'tool', type: 'execute', agentId: 'main', timestamp: 1000 }));
      store.writeEvent(makeEvent({ domain: 'agent', type: 'start', agentId: 'agent-1', timestamp: 2000 }));
      store.writeEvent(makeEvent({ domain: 'tool', type: 'result', agentId: 'agent-1', timestamp: 3000 }));
    });

    it('returns all events when no filter provided', () => {
      expect(store.readEvents()).toHaveLength(3);
    });

    it('filters by domain', () => {
      const events = store.readEvents({ domain: 'tool' });
      expect(events).toHaveLength(2);
      expect(events.every(e => e.domain === 'tool')).toBe(true);
    });

    it('filters by type', () => {
      const events = store.readEvents({ type: 'execute' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('execute');
    });

    it('filters by agentId', () => {
      const events = store.readEvents({ agentId: 'agent-1' });
      expect(events).toHaveLength(2);
      expect(events.every(e => e.agentId === 'agent-1')).toBe(true);
    });

    it('filters by since (inclusive)', () => {
      const events = store.readEvents({ since: 2000 });
      expect(events).toHaveLength(2);
      expect(events.every(e => e.timestamp >= 2000)).toBe(true);
    });

    it('combines multiple filters (AND logic)', () => {
      const events = store.readEvents({ domain: 'tool', agentId: 'agent-1' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('result');
    });
  });

  // --------------------------------------------------------------------------
  // getEventCount
  // --------------------------------------------------------------------------
  describe('getEventCount', () => {
    it('tracks count correctly as events are written', () => {
      expect(store.getEventCount()).toBe(0);
      store.writeEvent(makeEvent());
      expect(store.getEventCount()).toBe(1);
      store.writeEvent(makeEvent());
      expect(store.getEventCount()).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // flush / loadFromFile
  // --------------------------------------------------------------------------
  describe('flush and loadFromFile', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'ies-test-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('flush writes JSONL to file', async () => {
      store.writeEvent(makeEvent({ type: 'run' }));
      const filePath = join(tmpDir, 'events.jsonl');
      await store.flush(filePath);

      const loaded = await InternalEventStore.loadFromFile(filePath);
      expect(loaded.getEventCount()).toBe(1);
      expect(loaded.readEvents()[0].type).toBe('run');
    });

    it('loadFromFile reads JSONL back correctly', async () => {
      store.writeEvent(makeEvent({ domain: 'agent', type: 'start', agentId: 'a1' }));
      store.writeEvent(makeEvent({ domain: 'tool', type: 'exec', agentId: 'a2' }));
      const filePath = join(tmpDir, 'events2.jsonl');
      await store.flush(filePath);

      const loaded = await InternalEventStore.loadFromFile(filePath);
      expect(loaded.getEventCount()).toBe(2);
      expect(loaded.readEvents({ domain: 'agent' })).toHaveLength(1);
      expect(loaded.readEvents({ agentId: 'a2' })).toHaveLength(1);
    });

    it('flush + loadFromFile round-trip preserves all event fields', async () => {
      const ts = 1700000000000;
      store.writeEvent(makeEvent({ domain: 'session', type: 'open', agentId: 'bot', data: { x: 42 }, timestamp: ts }));
      const filePath = join(tmpDir, 'round-trip.jsonl');
      await store.flush(filePath);

      const loaded = await InternalEventStore.loadFromFile(filePath);
      const ev = loaded.readEvents()[0];
      expect(ev.domain).toBe('session');
      expect(ev.type).toBe('open');
      expect(ev.agentId).toBe('bot');
      expect(ev.data).toEqual({ x: 42 });
      expect(ev.timestamp).toBe(ts);
      expect(ev.eventId).toMatch(/^evt-/);
    });

    it('loadFromFile with nonexistent file returns empty store', async () => {
      const loaded = await InternalEventStore.loadFromFile(join(tmpDir, 'nonexistent.jsonl'));
      expect(loaded.getEventCount()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // clear
  // --------------------------------------------------------------------------
  describe('clear', () => {
    it('removes all events', () => {
      store.writeEvent(makeEvent());
      store.writeEvent(makeEvent());
      store.clear();
      expect(store.getEventCount()).toBe(0);
      expect(store.readEvents()).toHaveLength(0);
    });
  });
});
