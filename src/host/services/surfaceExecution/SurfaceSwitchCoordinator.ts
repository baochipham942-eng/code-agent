import type {
  InteractiveSurfaceSessionV1,
  SurfaceExecutionEventV1,
  SurfaceKind,
} from '../../../shared/contract/surfaceExecution';
import type { SurfaceRuntimeIdentityV1 } from './SurfaceExecutionRuntime';
import { SurfaceEventHub } from './SurfaceEventHub';
import { SurfaceSessionManager } from './SurfaceSessionManager';

const DEFAULT_SWITCH_REASON: Record<SurfaceKind, string> = {
  browser: 'The next step requires browser tab, DOM, or web accessibility control.',
  computer: 'The next step requires native app, window, or desktop accessibility control.',
};

export class SurfaceSwitchCoordinator {
  private readonly activeSessionByOwner = new Map<string, string>();

  constructor(
    private readonly sessions: SurfaceSessionManager,
    private readonly events: SurfaceEventHub,
  ) {}

  parentSessionId(identity: SurfaceRuntimeIdentityV1, nextSurface: SurfaceKind): string | undefined {
    const previous = this.previousSession(identity);
    return previous && previous.surface !== nextSurface ? previous.sessionId : undefined;
  }

  activate(
    session: InteractiveSurfaceSessionV1,
    identity: SurfaceRuntimeIdentityV1,
    reason?: string,
  ): SurfaceExecutionEventV1 | null {
    const key = this.ownerKey(identity);
    const previous = this.previousSession(identity);
    this.activeSessionByOwner.set(key, session.sessionId);
    if (!previous || previous.sessionId === session.sessionId || previous.surface === session.surface) return null;
    const switchReason = reason?.trim() || DEFAULT_SWITCH_REASON[session.surface];
    return this.events.publish(
      { sessionId: session.sessionId, runId: session.runId, agentId: session.agentId },
      {
        phase: 'prepare',
        status: 'succeeded',
        userSummary: `Switched from ${previous.surface} to ${session.surface}: ${switchReason}`,
        ...(session.activeTarget ? { target: session.activeTarget } : {}),
        operation: {
          action: 'surface_switch',
          risk: 'control',
          approvalScope: `from:${previous.sessionId}`,
          expectedOutcome: switchReason,
        },
        evidenceRefs: [],
        artifactRefs: [],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      },
    );
  }

  private previousSession(identity: SurfaceRuntimeIdentityV1): InteractiveSurfaceSessionV1 | null {
    const sessionId = this.activeSessionByOwner.get(this.ownerKey(identity));
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session
      || session.conversationId !== identity.conversationId
      || session.runId !== identity.runId
      || session.agentId !== identity.agentId) return null;
    return session;
  }

  private ownerKey(identity: SurfaceRuntimeIdentityV1): string {
    return JSON.stringify([identity.conversationId, identity.runId, identity.agentId]);
  }
}
