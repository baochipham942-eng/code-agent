import crypto from 'crypto';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceEventHub } from './SurfaceEventHub';
import { SurfaceInterruptService } from './SurfaceInterruptService';
import { SurfaceObservationRegistry } from './SurfaceObservationRegistry';
import { SurfaceSessionManager } from './SurfaceSessionManager';

export type SurfaceTakeoverResolutionV1 = 'continue' | 'cancel' | 'timed_out' | 'navigated';

interface PendingTakeover {
  requestId: string;
  subject: SurfaceGrantSubjectV1;
  resolve: (resolution: SurfaceTakeoverResolutionV1) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SurfaceHumanTakeoverService {
  private readonly pending = new Map<string, PendingTakeover>();

  constructor(
    private readonly sessions: SurfaceSessionManager,
    private readonly observations: SurfaceObservationRegistry,
    private readonly interrupts: SurfaceInterruptService,
    private readonly events: SurfaceEventHub,
  ) {}

  async request(input: {
    subject: SurfaceGrantSubjectV1;
    reason: string;
    timeoutMs: number;
  }): Promise<{
    requestId: string;
    wait: Promise<SurfaceTakeoverResolutionV1>;
  }> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error('Human takeover timeout must be a positive finite duration.');
    }
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    await this.interrupts.takeover(input.subject);
    this.observations.invalidateSession(input.subject);
    const requestId = `surface_takeover_${crypto.randomUUID()}`;
    this.events.publish(input.subject, {
      phase: 'human',
      status: 'waiting',
      userSummary: input.reason,
      ...(session.activeTarget ? { target: session.activeTarget } : {}),
      evidenceRefs: [],
      artifactRefs: [],
      availableControls: ['resume', 'stop', 'end_session'],
    });
    const resolutionPromise = new Promise<SurfaceTakeoverResolutionV1>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve('timed_out');
      }, input.timeoutMs);
      this.pending.set(requestId, { requestId, subject: input.subject, resolve, timer });
    });
    const wait = resolutionPromise.then(async (resolution) => {
      if (resolution === 'continue' || resolution === 'navigated') this.interrupts.resume(input.subject);
      else await this.interrupts.stop(input.subject);
      this.events.publish(input.subject, {
        phase: 'human',
        status: resolution === 'continue' || resolution === 'navigated' ? 'succeeded' : 'cancelled',
        userSummary: `Human takeover ${resolution}`,
        ...(session.activeTarget ? { target: session.activeTarget } : {}),
        evidenceRefs: [],
        artifactRefs: [],
        availableControls: resolution === 'continue' || resolution === 'navigated'
          ? ['pause', 'takeover', 'stop', 'end_session']
          : ['end_session'],
        completedAt: Date.now(),
      });
      return resolution;
    });
    return { requestId, wait };
  }

  respond(
    requestId: string,
    subject: SurfaceGrantSubjectV1,
    resolution: Exclude<SurfaceTakeoverResolutionV1, 'timed_out'>,
  ): boolean {
    this.sessions.requireOwned(subject.sessionId, subject);
    const pending = this.pending.get(requestId);
    if (pending?.subject.sessionId !== subject.sessionId
      || pending?.subject.runId !== subject.runId
      || pending?.subject.agentId !== subject.agentId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(resolution);
    return true;
  }
}
