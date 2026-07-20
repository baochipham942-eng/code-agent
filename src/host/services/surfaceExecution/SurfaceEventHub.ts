import crypto from 'crypto';
import type {
  SurfaceExecutionEventV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import { sameSurfaceTargetV1 } from '../../../shared/contract/surfaceExecution';
import { sanitizeSurfaceExecutionEventV1 } from '../../../shared/utils/surfaceExecutionRedaction';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceSessionManager } from './SurfaceSessionManager';

export type SurfaceExecutionEventDraftV1 = Omit<
  SurfaceExecutionEventV1,
  'version' | 'eventId' | 'sequence' | 'sessionId' | 'runId' | 'agentId' | 'surface' | 'startedAt'
> & {
  eventId?: string;
  startedAt?: number;
};

interface SurfaceEventHubOptions {
  now?: () => number;
  createId?: () => string;
  onEvent?: (event: SurfaceExecutionEventV1) => void;
}

export class SurfaceEventHub {
  private readonly events = new Map<string, SurfaceExecutionEventV1[]>();
  private readonly listeners = new Map<string, Set<(event: SurfaceExecutionEventV1) => void>>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onEvent?: (event: SurfaceExecutionEventV1) => void;

  constructor(
    private readonly sessions: SurfaceSessionManager,
    options: SurfaceEventHubOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => `surface_event_${crypto.randomUUID()}`);
    this.onEvent = options.onEvent;
  }

  publish(
    subject: SurfaceGrantSubjectV1,
    draft: SurfaceExecutionEventDraftV1,
  ): SurfaceExecutionEventV1 {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    if (draft.target && session.activeTarget && !sameSurfaceTargetV1(draft.target, session.activeTarget)) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_TARGET_NOT_OWNED',
        message: 'Surface event target does not match the active target revision.',
        phase: draft.phase,
        recommendedAction: 'Refresh the active target before publishing the event.',
        surface: session.surface,
        provider: session.provider,
        sessionId: session.sessionId,
        targetRef: draft.target,
      });
    }
    const list = this.events.get(session.sessionId) || [];
    const event = sanitizeSurfaceExecutionEventV1({
      ...draft,
      version: 1,
      eventId: draft.eventId || this.createId(),
      sequence: list.length === 0 ? 1 : list[list.length - 1].sequence + 1,
      sessionId: session.sessionId,
      runId: session.runId,
      agentId: session.agentId,
      surface: session.surface,
      startedAt: draft.startedAt ?? this.now(),
    });
    list.push(event);
    this.events.set(session.sessionId, list);
    this.onEvent?.(structuredClone(event));
    for (const listener of this.listeners.get(session.sessionId) || []) {
      listener(structuredClone(event));
    }
    return structuredClone(event);
  }

  listOwned(subject: SurfaceGrantSubjectV1): SurfaceExecutionEventV1[] {
    this.sessions.requireOwned(subject.sessionId, subject);
    return (this.events.get(subject.sessionId) || []).map((event) => structuredClone(event));
  }

  subscribeOwned(
    subject: SurfaceGrantSubjectV1,
    listener: (event: SurfaceExecutionEventV1) => void,
  ): () => void {
    this.sessions.requireOwned(subject.sessionId, subject);
    const listeners = this.listeners.get(subject.sessionId) || new Set();
    listeners.add(listener);
    this.listeners.set(subject.sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(subject.sessionId);
    };
  }
}

export function targetForSurfaceEvent(
  target: SurfaceTargetRefV1 | undefined,
): SurfaceTargetRefV1 | undefined {
  return target ? structuredClone(target) : undefined;
}
