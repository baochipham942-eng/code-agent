import type { AgentEvent } from './categories';
import { STABLE_EVENT_TYPES } from '@shared/contract';
import { type AgentEventType } from './categories';

export type { AgentEventType } from './categories';

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

/**
 * Stable events eligible for unattended delivery. This preserves the current
 * background delivery set while taking its source from the schema-stable
 * contract: stable events outside this set remain excluded.
 */
const BACKGROUND_STABLE_EVENT_TYPE_ALLOWLIST = new Set<AgentEventType>([
  'turn_start',
  'turn_end',
  'agent_complete',
  'agent_cancelled',
  'tool_call_end',
  'artifact_write_started',
  'artifact_locator',
  'permission_request',
  'error',
]);

const BACKGROUND_STABLE_EVENT_TYPES = [...STABLE_EVENT_TYPES]
  .filter((type) => BACKGROUND_STABLE_EVENT_TYPE_ALLOWLIST.has(type));

/** Experimental events intentionally delivered to unattended consumers. */
export const BACKGROUND_AGENT_EXPERIMENTAL_EVENT_TYPES: readonly AgentEventType[] = [
  'turn_diff',
];

/** Shared allowlist for unattended consumers that do not render stream deltas. */
export const BACKGROUND_AGENT_EVENT_FILTER = defineAgentEventFilter({
  include: [...BACKGROUND_STABLE_EVENT_TYPES, ...BACKGROUND_AGENT_EXPERIMENTAL_EVENT_TYPES],
});
