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
  // zustand v5 的 useStore 是裸 useSyncExternalStore（无 selector 记忆化/等值比较），
  // selector 必须返回引用稳定的值。这里直取 state 切片（store 不更新则引用恒等），
  // 派生（按 session 取值 + ?? null）放进 useMemo——绝不在 selector 里现算。
  const hookRunningBySession = useTurnExecutionStore((state) => state.hookRunningBySession);
  const hookRunning = useMemo(
    () => (projection.sessionId ? (hookRunningBySession[projection.sessionId] ?? null) : null),
    [hookRunningBySession, projection.sessionId],
  );

  return useMemo(
    () => buildTurnExecutionClarityProjection({
      projection,
      capabilities,
      launchRequests,
      swarmEvents,
      routingEvents,
      hookEvents,
      hookRunning,
    }),
    [capabilities, hookEvents, hookRunning, launchRequests, projection, routingEvents, swarmEvents],
  );
}
