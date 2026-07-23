import type { SwarmEvent } from '@shared/contract/swarm';

interface ActiveSwarmProjection {
  activeSessionId?: string;
  activeRunId?: string;
  startTime?: number;
  lastEventAt?: number;
}

export function isSwarmSurfaceArtifact(event: SwarmEvent): boolean {
  return event.type === 'swarm:launch:requested' || event.type === 'swarm:started';
}

function isSelectedSessionSwarmRoot(
  event: SwarmEvent,
  currentSessionId: string | null,
): boolean {
  return event.sessionId === currentSessionId
    && isSwarmSurfaceArtifact(event);
}

/**
 * Root events are process-wide and can arrive late. The App may explicitly follow a root from
 * the selected session only when there is no bound run, or when its source timestamp proves it
 * started after the visible run. The store itself never lets a foreign run steal the projection.
 */
export function shouldActivateSwarmScopeFromRoot(
  event: SwarmEvent,
  currentSessionId: string | null,
  projection: ActiveSwarmProjection,
): boolean {
  if (!isSelectedSessionSwarmRoot(event, currentSessionId)) return false;
  if (projection.activeSessionId !== event.sessionId || !projection.activeRunId) return true;
  if (projection.activeRunId === event.runId) return false;

  const activeRootAt = projection.startTime ?? projection.lastEventAt;
  return activeRootAt !== undefined && event.timestamp > activeRootAt;
}
