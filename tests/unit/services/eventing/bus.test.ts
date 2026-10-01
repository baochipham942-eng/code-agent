import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '../../../../src/host/protocol/events/busTypes';
import { EventBus } from '../../../../src/host/services/eventing/bus';
import * as eventSinks from '../../../../src/host/services/eventing/eventSinks';
import {
  getInternalEventStore,
  resetInternalEventStore,
} from '../../../../src/host/services/eventing/internalStore';

describe('EventBus sink resolution', () => {
  let bus: EventBus;

  beforeEach(() => {
    resetInternalEventStore();
    bus = new EventBus();
  });

  afterEach(() => {
    bus.shutdown();
    resetInternalEventStore();
    vi.restoreAllMocks();
  });

  it('keeps empty-table publish behaviour for persistence and bridge metadata', () => {
    const writeEvent = vi.spyOn(getInternalEventStore(), 'writeEvent');
    const events: BusEvent[] = [];
    const unsubscribe = bus.subscribe('*', event => {
      events.push(event);
    });

    bus.publish('tool', 'x', { value: 1 });
    bus.publish('swarm', 'y', { value: 2 }, { bridgeToRenderer: false });
    bus.publish('agent', 'z', { value: 3 });

    expect(writeEvent).toHaveBeenCalledTimes(2);
    expect(writeEvent.mock.calls.map(([event]) => `${event.domain}:${event.type}`)).toEqual(['tool:x', 'agent:z']);
    expect(events.map(event => `${event.domain}:${event.type}:${event.bridgeToRenderer}`)).toEqual([
      'tool:x:true',
      'swarm:y:false',
      'agent:z:true',
    ]);

    unsubscribe();
  });

  it('consults the resolver once per event and still delivers none events to subscribers', () => {
    const table: NonNullable<Parameters<typeof eventSinks.resolveEventSinks>[3]> = {
      'swarm:persist': 'persist',
      'tool:external': 'external',
      'swarm:both': 'both',
      'tool:none': 'none',
    };
    const realResolve = eventSinks.resolveEventSinks;
    const resolve = vi.spyOn(eventSinks, 'resolveEventSinks').mockImplementation(
      (domain, type, callSiteBridge) => realResolve(domain, type, callSiteBridge, table),
    );
    const writeEvent = vi.spyOn(getInternalEventStore(), 'writeEvent');
    const events: BusEvent[] = [];
    const typeHandler = vi.fn();
    const domainHandler = vi.fn();
    bus.subscribe('*', event => { events.push(event); });
    bus.subscribe('tool:none', typeHandler);
    bus.subscribe('tool', domainHandler);

    bus.publish('swarm', 'persist', {}, { bridgeToRenderer: true });
    bus.publish('tool', 'external', {}, { bridgeToRenderer: false });
    bus.publish('swarm', 'both', {}, { bridgeToRenderer: false });
    bus.publish('tool', 'none', {}, { bridgeToRenderer: true });

    expect(resolve).toHaveBeenCalledTimes(4);
    expect(writeEvent.mock.calls.map(([event]) => `${event.domain}:${event.type}`)).toEqual([
      'swarm:persist',
      'swarm:both',
    ]);
    expect(events.map(event => event.bridgeToRenderer)).toEqual([false, true, true, false]);
    expect(typeHandler).toHaveBeenCalledWith(events[3]);
    expect(domainHandler).toHaveBeenCalledTimes(2);
  });
});
