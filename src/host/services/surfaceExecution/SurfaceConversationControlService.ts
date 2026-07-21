import type {
  InteractiveSurfaceSessionV1,
  SurfaceConversationSnapshotV1,
  SurfaceExecutionEventV1,
  SurfaceGrantSummaryV1,
  SurfaceSessionControlActionV1,
  SurfaceSessionControlResultV1,
} from '../../../shared/contract/surfaceExecution';
import type { RunRegistry } from '../../runtime/runRegistry';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceAccessGrantService } from './SurfaceAccessGrantService';
import { SurfaceEventHub } from './SurfaceEventHub';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceHumanTakeoverService } from './SurfaceHumanTakeoverService';
import { SurfaceInterruptService } from './SurfaceInterruptService';
import type { SurfaceOutputRegistry } from './SurfaceOutputRegistry';
import { SurfaceSessionManager } from './SurfaceSessionManager';
import type { SurfaceTakeoverControlV1 } from './surfaceBrowserRuntimeTypes';

function outputLabel(ref: string, index: number): string {
  if (!ref.startsWith('artifact://')) return `Output ${index + 1}`;
  const withoutQuery = ref.slice('artifact://'.length).split(/[?#]/, 1)[0];
  const candidate = withoutQuery.split('/').filter(Boolean).at(-1)?.trim();
  if (!candidate) return `Output ${index + 1}`;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

export class SurfaceConversationControlService {
  private readonly pendingTakeovers = new Map<string, SurfaceTakeoverControlV1>();

  constructor(
    private readonly sessions: SurfaceSessionManager,
    private readonly grants: SurfaceAccessGrantService,
    private readonly events: SurfaceEventHub,
    private readonly interrupts: SurfaceInterruptService,
    private readonly takeover: SurfaceHumanTakeoverService,
    private readonly runRegistry: RunRegistry,
    private readonly now: () => number = Date.now,
    private readonly outputs?: SurfaceOutputRegistry,
  ) {}

  snapshotConversation(conversationId: string): SurfaceConversationSnapshotV1 {
    const sessions = this.sessions.listByConversation(conversationId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((session) => {
        const { grantId, ...safeSession } = session;
        const subject = {
          sessionId: session.sessionId,
          runId: session.runId,
          agentId: session.agentId,
        };
        const events = this.events.list(session.sessionId).map((event) => ({
          ...event,
          artifactRefs: this.outputs
            ? this.outputs.projectRefs(subject, event.artifactRefs)
            : event.artifactRefs,
        }));
        const evidence = Array.from(new Map(events.flatMap((event) => event.evidence || [])
          .map((card) => [card.evidenceId, card])).values());
        const registeredOutputs = this.outputs?.listOwned(subject) || [];
        const artifactRefs = Array.from(new Set([
          ...events.flatMap((event) => event.artifactRefs),
          ...registeredOutputs.map((output) => output.ref),
        ]));
        const activeRun = this.runRegistry.resolve({
          runId: session.runId,
          sessionId: session.conversationId,
        });
        const writable = Boolean(activeRun && !activeRun.cancellationRequested)
          && session.state !== 'completed'
          && session.state !== 'failed';
        const updatedAt = Math.max(
          session.heartbeatAt,
          ...events.map((event) => event.completedAt || event.startedAt),
        );
        return {
          version: 1 as const,
          session: safeSession,
          grant: this.grantSummary(grantId),
          events,
          evidence,
          outputs: this.outputs
            ? this.outputs.describeRefs(subject, artifactRefs)
            : artifactRefs.map((ref, index) => ({
                ref,
                kind: 'artifact' as const,
                label: outputLabel(ref, index),
              })),
          availableControls: this.availableControls(session, writable),
          source: 'live' as const,
          writable,
          updatedAt,
        };
      });
    return {
      version: 1,
      conversationId,
      sessions,
      updatedAt: sessions.length > 0
        ? Math.max(...sessions.map((session) => session.updatedAt))
        : this.now(),
    };
  }

  async controlConversation(input: {
    conversationId: string;
    surfaceSessionId: string;
    action: SurfaceSessionControlActionV1;
    reason?: string;
  }): Promise<SurfaceSessionControlResultV1> {
    if (input.action === 'continue') {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_POLICY_BLOCKED',
        message: 'Durable continuation must be prepared from an owned conversation checkpoint.',
        phase: 'recover',
        recommendedAction: 'Use the conversation Surface continuation control.',
        surface: 'browser',
        provider: 'surface-runtime',
        sessionId: input.surfaceSessionId,
      });
    }
    const session = this.sessions.get(input.surfaceSessionId);
    if (session?.conversationId !== input.conversationId) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_TARGET_NOT_OWNED',
        message: 'Surface session is unavailable for this conversation.',
        phase: 'human',
        recommendedAction: 'Refresh the conversation Surface snapshot.',
        surface: 'browser',
        provider: 'unknown',
        sessionId: input.surfaceSessionId,
      });
    }
    const projection = this.snapshotConversation(input.conversationId).sessions
      .find((candidate) => candidate.session.sessionId === input.surfaceSessionId);
    if (!projection?.writable || !projection.availableControls.includes(input.action)) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_POLICY_BLOCKED',
        message: 'Surface control is unavailable for the current session state.',
        phase: 'human',
        recommendedAction: 'Refresh the conversation Surface snapshot before retrying.',
        surface: session.surface,
        provider: session.provider,
        sessionId: session.sessionId,
      });
    }
    const controlled = await this.control(this.subjectFor(session), input.action, {
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return {
      version: 1,
      ...(controlled ? { requestId: controlled.requestId } : {}),
      snapshot: this.snapshotConversation(input.conversationId),
    };
  }

  async control(
    subject: SurfaceGrantSubjectV1,
    action: SurfaceSessionControlActionV1,
    options?: { reason?: string; timeoutMs?: number },
  ): Promise<void | SurfaceTakeoverControlV1> {
    if (action === 'continue') {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_POLICY_BLOCKED',
        message: 'Durable continuation requires a persisted conversation checkpoint.',
        phase: 'recover',
        recommendedAction: 'Use the conversation Surface continuation control.',
        surface: 'browser',
        provider: 'surface-runtime',
        sessionId: subject.sessionId,
      });
    }
    if (action === 'pause') {
      await this.interrupts.pause(subject);
      this.publishControlEvent(subject, action);
      return;
    }
    if (action === 'takeover') {
      const pending = await this.takeover.request({
        subject,
        reason: options?.reason || 'Waiting for human control',
        timeoutMs: options?.timeoutMs || 5 * 60_000,
      });
      this.pendingTakeovers.set(subject.sessionId, pending);
      void pending.wait.then(
        () => this.deletePendingTakeover(subject.sessionId, pending.requestId),
        () => this.deletePendingTakeover(subject.sessionId, pending.requestId),
      );
      this.publishControlEvent(subject, action);
      return pending;
    }
    if (action === 'resume') {
      const pending = this.pendingTakeovers.get(subject.sessionId);
      if (pending && this.takeover.respond(pending.requestId, subject, 'continue')) {
        await pending.wait;
      } else {
        this.interrupts.resume(subject);
      }
      this.publishControlEvent(subject, action);
      return;
    }
    await this.cancelPendingTakeover(subject);
    if (action === 'stop') await this.interrupts.stop(subject);
    else await this.interrupts.endSession(subject);
    this.publishControlEvent(subject, action);
  }

  async cancelPendingTakeover(subject: SurfaceGrantSubjectV1): Promise<void> {
    const pending = this.pendingTakeovers.get(subject.sessionId);
    if (!pending) return;
    if (this.takeover.respond(pending.requestId, subject, 'cancel')) await pending.wait;
  }

  private subjectFor(session: InteractiveSurfaceSessionV1): SurfaceGrantSubjectV1 {
    return {
      sessionId: session.sessionId,
      runId: session.runId,
      agentId: session.agentId,
    };
  }

  private grantSummary(grantId?: string): SurfaceGrantSummaryV1 {
    const grant = grantId ? this.grants.get(grantId) : null;
    if (!grant) {
      return { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] };
    }
    const state: SurfaceGrantSummaryV1['state'] = grant.revokedAt !== undefined
      ? 'revoked'
      : grant.expiresAt <= this.now()
        ? 'expired'
        : grant.consumedAt !== undefined
          ? 'consumed'
          : 'active';
    return {
      state,
      capabilities: [...grant.capabilities],
      actionClasses: [...grant.actionClasses],
      dataScopes: [...grant.dataScopes],
      expiresAt: grant.expiresAt,
    };
  }

  private availableControls(
    session: InteractiveSurfaceSessionV1,
    writable: boolean,
  ): SurfaceSessionControlActionV1[] {
    if (!writable || session.state === 'completed' || session.state === 'failed') return [];
    if (session.state === 'stopping') return session.capabilities.supports.cleanup ? ['end_session'] : [];
    const controls: SurfaceSessionControlActionV1[] = [];
    if (session.state === 'running' && session.capabilities.supports.pause) controls.push('pause');
    if ((session.state === 'paused' || session.state === 'waiting_human')
      && session.capabilities.supports.pause) controls.push('resume');
    if ((session.state === 'running' || session.state === 'paused')
      && session.capabilities.supports.takeover) controls.push('takeover');
    if (session.capabilities.supports.cancel) controls.push('stop');
    if (session.capabilities.supports.cleanup) controls.push('end_session');
    return controls;
  }

  private publishControlEvent(
    subject: SurfaceGrantSubjectV1,
    action: SurfaceSessionControlActionV1,
  ): void {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    const status: SurfaceExecutionEventV1['status'] = action === 'takeover' || action === 'pause'
      ? 'waiting'
      : action === 'stop' ? 'cancelled' : 'succeeded';
    this.events.publish(subject, {
      phase: action === 'stop' || action === 'end_session' ? 'cleanup' : 'human',
      status,
      userSummary: `Surface control ${action} ${status}`,
      ...(session.activeTarget ? { target: session.activeTarget } : {}),
      operation: { action, risk: 'control' },
      evidenceRefs: [],
      artifactRefs: [],
      availableControls: this.availableControls(session, true),
      completedAt: this.now(),
    });
  }

  private deletePendingTakeover(sessionId: string, requestId: string): void {
    if (this.pendingTakeovers.get(sessionId)?.requestId === requestId) {
      this.pendingTakeovers.delete(sessionId);
    }
  }
}
