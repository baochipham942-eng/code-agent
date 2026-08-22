import type { AgentEvent } from './categories';
import {
  IMMEDIATE_EVENT_TYPES,
  isTurnLifecycleEvent,
  type AgentEventType,
} from './categories';

export type { AgentEventType } from './categories';

/**
 * AgentEvent type names currently come from the shared discriminated union.
 * N-EVTSCHEMA will replace that source with its schema-stable set; keep that
 * source swap and all runtime matching in this module.
 */
export interface AgentEventFilter {
  include?: readonly AgentEventType[];
  exclude?: readonly AgentEventType[];
}

function defineAgentEventFilter(filter: AgentEventFilter): AgentEventFilter {
  return filter;
}

export function shouldDeliverAgentEvent(
  event: AgentEvent | AgentEventType,
  filter?: AgentEventFilter,
): boolean {
  if (!filter) return true;
  const type = typeof event === 'string' ? event : event.type;
  if (filter.include && !filter.include.includes(type)) return false;
  return !filter.exclude?.includes(type);
}

const BACKGROUND_IMMEDIATE_EVENT_TYPES = [...IMMEDIATE_EVENT_TYPES].filter((type) => (
  isTurnLifecycleEvent(type)
  || type === 'tool_call_end'
  || type === 'artifact_write_started'
  || type === 'permission_request'
  || type === 'error'
));

/** Shared allowlist for unattended consumers that do not render stream deltas. */
export const BACKGROUND_AGENT_EVENT_FILTER = defineAgentEventFilter({
  include: [...BACKGROUND_IMMEDIATE_EVENT_TYPES, 'artifact_locator'],
});
