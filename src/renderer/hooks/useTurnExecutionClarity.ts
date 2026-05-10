import { useMemo } from 'react';
import type { TraceProjection } from '@shared/contract/trace';
import { useSwarmStore } from '../stores/swarmStore';
import { useTurnExecutionStore, type HookActivityEvent, type RoutingEvidenceEvent } from '../stores/turnExecutionStore';
import { useWorkbenchCapabilities } from './useWorkbenchCapabilities';
import { buildTurnExecutionClarityProjection } from '../utils/turnTimelineProjection';

const EMPTY_ROUTING_EVENTS: RoutingEvidenceEvent[] = [];
const EMPTY_HOOK_EVENTS: HookActivityEvent[] = [];

export function useTurnExecutionClarity(
  projection: TraceProjection,
): TraceProjection {
  const capabilities = useWorkbenchCapabilities();
  const launchRequests = useSwarmStore((state) => state.launchRequests);
  const swarmEvents = useSwarmStore((state) => state.eventLog);
  const routingEvents = useTurnExecutionStore((state) =>
    projection.sessionId ? (state.routingEventsBySession[projection.sessionId] || EMPTY_ROUTING_EVENTS) : EMPTY_ROUTING_EVENTS,
  );
  const hookEvents = useTurnExecutionStore((state) =>
    projection.sessionId ? (state.hookEventsBySession[projection.sessionId] || EMPTY_HOOK_EVENTS) : EMPTY_HOOK_EVENTS,
  );

  return useMemo(
    () => buildTurnExecutionClarityProjection({
      projection,
      capabilities,
      launchRequests,
      swarmEvents,
      routingEvents,
      hookEvents,
    }),
    [capabilities, hookEvents, launchRequests, projection, routingEvents, swarmEvents],
  );
}
