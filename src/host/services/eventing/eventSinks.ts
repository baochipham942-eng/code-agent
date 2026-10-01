import type { EventDomain } from '../../protocol/events/busTypes';

type EventSink = 'persist' | 'external' | 'both' | 'none';

/**
 * 'persist' writes only to the store; 'external' enables only the bridge;
 * 'both' enables both sinks; 'none' enables neither sink.
 * A matching domain:type row wins over the call-site bridge flag. Missing
 * rows retain today's domain persistence and call-site bridge defaults.
 */
const EVENT_SINK_TABLE: Readonly<Record<string, EventSink>> = {};

const PERSISTENT_DOMAINS: readonly EventDomain[] = ['tool', 'agent', 'session'];

export function resolveEventSinks(
  domain: EventDomain,
  type: string,
  callSiteBridge?: boolean,
  table: Readonly<Record<string, EventSink>> = EVENT_SINK_TABLE,
): { persist: boolean; external: boolean } {
  const key = `${domain}:${type}`;
  const row = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  if (row !== undefined) {
    switch (row) {
      case 'persist':
        return { persist: true, external: false };
      case 'external':
        return { persist: false, external: true };
      case 'both':
        return { persist: true, external: true };
      case 'none':
        return { persist: false, external: false };
    }
  }

  return {
    persist: PERSISTENT_DOMAINS.includes(domain),
    external: callSiteBridge ?? true,
  };
}
