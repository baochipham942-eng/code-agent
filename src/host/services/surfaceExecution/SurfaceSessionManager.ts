import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'crypto';
import type {
  InteractiveSurfaceSessionV1,
  SurfaceCapabilityManifestV1,
  SurfaceKind,
  SurfaceSessionStateV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import { canTransitionSurfaceSessionV1 } from '../../../shared/contract/surfaceExecution';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

export interface SurfaceSessionOwnerV1 {
  runId: string;
  agentId: string;
}

interface SurfaceSessionCleanupOwnerV1 extends SurfaceSessionOwnerV1 {
  sessionId: string;
}

export interface CreateSurfaceSessionInput {
  conversationId: string;
  runId: string;
  agentId: string;
  surface: SurfaceKind;
  provider: string;
  capabilities: SurfaceCapabilityManifestV1;
  activeTarget?: SurfaceTargetRefV1;
  taskId?: string;
  turnId?: string;
  parentSessionId?: string;
  expiresAt?: number;
}

interface SurfaceSessionManagerOptions {
  now?: () => number;
  createId?: () => string;
  assertActiveOwner?: (input: {
    conversationId: string;
    runId: string;
    agentId: string;
  }) => void;
}

export class SurfaceSessionManager {
  private readonly sessions = new Map<string, InteractiveSurfaceSessionV1>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly assertActiveOwner?: SurfaceSessionManagerOptions['assertActiveOwner'];
  private readonly cleanupOwner = new AsyncLocalStorage<SurfaceSessionCleanupOwnerV1>();

  constructor(options: SurfaceSessionManagerOptions = {}) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => `surface_${crypto.randomUUID()}`);
    this.assertActiveOwner = options.assertActiveOwner;
  }

  create(input: CreateSurfaceSessionInput): InteractiveSurfaceSessionV1 {
    if (!input.conversationId || !input.runId || !input.agentId) {
      throw new Error('Surface session requires conversationId, runId, and agentId.');
    }
    this.assertActiveOwner?.({
      conversationId: input.conversationId,
      runId: input.runId,
      agentId: input.agentId,
    });
    if (input.capabilities.surface !== input.surface || input.capabilities.provider !== input.provider) {
      throw new Error('Surface capability manifest does not match the requested surface/provider.');
    }
    const now = this.now();
    const session: InteractiveSurfaceSessionV1 = {
      version: 1,
      sessionId: this.createId(),
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      conversationId: input.conversationId,
      agentId: input.agentId,
      surface: input.surface,
      provider: input.provider,
      capabilities: input.capabilities,
      state: 'preparing',
      ...(input.activeTarget ? { activeTarget: input.activeTarget } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      startedAt: now,
      heartbeatAt: now,
      ...(typeof input.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {}),
    };
    this.sessions.set(session.sessionId, session);
    return structuredClone(session);
  }

  findActive(input: {
    conversationId: string;
    runId: string;
    agentId: string;
    surface: SurfaceKind;
    provider?: string;
  }): InteractiveSurfaceSessionV1 | null {
    for (const session of this.sessions.values()) {
      if (session.conversationId !== input.conversationId
        || session.runId !== input.runId
        || session.agentId !== input.agentId
        || session.surface !== input.surface
        || (input.provider && session.provider !== input.provider)
        || session.state === 'completed'
        || session.state === 'failed') {
        continue;
      }
      if (session.expiresAt && session.expiresAt <= this.now()) continue;
      return structuredClone(session);
    }
    return null;
  }

  get(sessionId: string): InteractiveSurfaceSessionV1 | null {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  requireOwned(sessionId: string, owner: SurfaceSessionOwnerV1): InteractiveSurfaceSessionV1 {
    const session = this.requireStoredOwner(sessionId, owner);
    const cleanupOwner = this.cleanupOwner.getStore();
    const isCleanupOwner = cleanupOwner?.sessionId === sessionId
      && cleanupOwner.runId === owner.runId
      && cleanupOwner.agentId === owner.agentId;
    if (!isCleanupOwner) {
      this.assertActiveOwner?.({
        conversationId: session.conversationId,
        runId: owner.runId,
        agentId: owner.agentId,
      });
    }
    return structuredClone(session);
  }

  async withCancellingOwnerCleanup<T>(
    sessionId: string,
    owner: SurfaceSessionOwnerV1,
    cleanup: () => Promise<T>,
  ): Promise<T> {
    this.requireStoredOwner(sessionId, owner);
    return this.cleanupOwner.run({ sessionId, ...owner }, cleanup);
  }

  private requireStoredOwner(
    sessionId: string,
    owner: SurfaceSessionOwnerV1,
  ): InteractiveSurfaceSessionV1 {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw this.runtimeError(sessionId, 'SURFACE_SESSION_NOT_FOUND', 'Surface session was not found.', 'Create a new Surface session.');
    }
    if (session.expiresAt && session.expiresAt <= this.now()) {
      throw this.runtimeError(sessionId, 'SURFACE_SESSION_EXPIRED', 'Surface session has expired.', 'Create a new Surface session.', session);
    }
    if (session.runId !== owner.runId || session.agentId !== owner.agentId) {
      throw this.runtimeError(sessionId, 'SURFACE_TARGET_NOT_OWNED', 'Surface session belongs to another run or agent.', 'Use the owning run and agent.', session);
    }
    return session;
  }

  transition(
    sessionId: string,
    owner: SurfaceSessionOwnerV1,
    nextState: SurfaceSessionStateV1,
  ): InteractiveSurfaceSessionV1 {
    const current = this.requireOwned(sessionId, owner);
    if (current.state !== nextState && !canTransitionSurfaceSessionV1(current.state, nextState)) {
      throw this.runtimeError(
        sessionId,
        'SURFACE_POLICY_BLOCKED',
        `Invalid Surface session transition: ${current.state} -> ${nextState}`,
        'Use a valid Surface session control transition.',
        current,
      );
    }
    const stored = this.sessions.get(sessionId) as InteractiveSurfaceSessionV1;
    stored.state = nextState;
    stored.heartbeatAt = this.now();
    return structuredClone(stored);
  }

  heartbeat(sessionId: string, owner: SurfaceSessionOwnerV1): InteractiveSurfaceSessionV1 {
    this.requireOwned(sessionId, owner);
    const stored = this.sessions.get(sessionId) as InteractiveSurfaceSessionV1;
    stored.heartbeatAt = this.now();
    return structuredClone(stored);
  }

  setActiveTarget(
    sessionId: string,
    owner: SurfaceSessionOwnerV1,
    target: SurfaceTargetRefV1,
  ): InteractiveSurfaceSessionV1 {
    const current = this.requireOwned(sessionId, owner);
    if (current.surface !== target.kind) {
      throw this.runtimeError(sessionId, 'SURFACE_POLICY_BLOCKED', 'Target kind does not match Surface session.', 'Select a target on the active Surface.', current);
    }
    const stored = this.sessions.get(sessionId) as InteractiveSurfaceSessionV1;
    stored.activeTarget = structuredClone(target);
    stored.heartbeatAt = this.now();
    return structuredClone(stored);
  }

  attachGrant(
    sessionId: string,
    owner: SurfaceSessionOwnerV1,
    grantId: string,
  ): InteractiveSurfaceSessionV1 {
    this.requireOwned(sessionId, owner);
    const stored = this.sessions.get(sessionId) as InteractiveSurfaceSessionV1;
    stored.grantId = grantId;
    stored.heartbeatAt = this.now();
    return structuredClone(stored);
  }

  listByConversationOwned(
    conversationId: string,
    owner: SurfaceSessionOwnerV1,
  ): InteractiveSurfaceSessionV1[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.conversationId === conversationId
        && session.runId === owner.runId
        && session.agentId === owner.agentId)
      .map((session) => structuredClone(session));
  }

  /** Host-only enumeration. Callers must complete conversation ownership checks first. */
  listByConversation(conversationId: string): InteractiveSurfaceSessionV1[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.conversationId === conversationId)
      .map((session) => structuredClone(session));
  }

  private runtimeError(
    sessionId: string,
    code: 'SURFACE_SESSION_NOT_FOUND' | 'SURFACE_SESSION_EXPIRED' | 'SURFACE_TARGET_NOT_OWNED' | 'SURFACE_POLICY_BLOCKED',
    message: string,
    recommendedAction: string,
    session?: InteractiveSurfaceSessionV1,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'prepare',
      recommendedAction,
      surface: session?.surface || 'browser',
      provider: session?.provider || 'unknown',
      sessionId,
      ...(session?.activeTarget ? { targetRef: session.activeTarget } : {}),
    });
  }
}
