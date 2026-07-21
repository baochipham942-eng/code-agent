import type { ComputerUseExpectationV1, ComputerUseStateViewV1 } from '../../../shared/contract/desktop';
import type {
  InteractiveSurfaceSessionV1, SurfaceActionResultV1, SurfaceConversationSnapshotV1,
  SurfaceExecutionEventV1, SurfaceObservationV1,
  SurfaceSessionControlActionV1, SurfaceSessionControlResultV1,
} from '../../../shared/contract/surfaceExecution';
import { getApplicationRunRegistry } from '../../app/applicationRunRegistry';
import type { RunRegistry } from '../../runtime/runRegistry';
import {
  releaseCuaLock,
  type CuaInputLockLifecycleEvent,
} from '../../mcp/cuaSessionLock';
import { resetCuaBudget } from '../../mcp/cuaTrajectoryBudget';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceAccessGrantService } from './SurfaceAccessGrantService';
import { assertBrowserElementRefsOwned } from './BrowserElementRefFence';
import {
  BrowserTabLeaseService,
  type BrowserTabLeaseSubjectV1,
} from './BrowserTabLeaseService';
import { SurfaceCapabilityRegistry } from './SurfaceCapabilityRegistry';
import { SurfaceConversationControlService } from './SurfaceConversationControlService';
import {
  getSurfaceContinuationService,
  resetSurfaceContinuationServiceForTests,
  type SurfaceContinuationService,
} from './SurfaceContinuationService';
import { SurfaceEventHub } from './SurfaceEventHub';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceFrameRegistry } from './SurfaceFrameRegistry';
import { SurfaceHumanTakeoverService } from './SurfaceHumanTakeoverService';
import { SurfaceInterruptService } from './SurfaceInterruptService';
import { SurfaceObservationRegistry } from './SurfaceObservationRegistry';
import { SurfaceOutputRegistry } from './SurfaceOutputRegistry';
import {
  BROWSER_SURFACE_OPERATIONS, DEFAULT_BROWSER_PROVIDER, RELAY_BROWSER_PROVIDER,
  RELAY_BROWSER_SURFACE_OPERATIONS,
  type BrowserStateBinding,
  type ExecuteBrowserActionInputV1,
  type GetBrowserBindingInputV1,
  type PrepareBrowserSessionInputV1,
  type PrepareBrowserSessionResultV1,
  type RecordBrowserObservationInputV1,
  type RecordBrowserObservationResultV1,
  type RegisterBrowserTabLeaseCleanupInputV1,
  type SurfaceBrowserBindingResultV1,
  type SurfaceBrowserActionExecutionV1,
  type SurfaceTakeoverControlV1,
} from './surfaceBrowserRuntimeTypes';
import {
  SurfaceOperationCoordinator,
  type SurfaceProviderActionOutcomeV1,
} from './SurfaceOperationCoordinator';
import { SurfaceSessionManager } from './SurfaceSessionManager';
import { SurfaceSwitchCoordinator } from './SurfaceSwitchCoordinator';
import {
  projectSurfaceComputerError,
  type SurfaceComputerErrorInputV1,
} from './surfaceComputerErrorProjection';
import {
  computerExpectationToSurface,
  computerTargetFromState,
  recordComputerInputLockLifecycleEvent,
} from './surfaceComputerRuntimeHelpers';
import { publishSurfaceContinuationEvent } from './surfaceContinuationRuntime';
import { assertSurfaceRunOwner } from './surfaceRunOwnership';

export interface SurfaceRuntimeIdentityV1 {
  conversationId: string;
  runId: string;
  turnId?: string;
  agentId: string;
  emitSurfaceEvent?: (event: SurfaceExecutionEventV1) => void;
}

export interface SurfaceComputerStateMetadataV1 {
  providerGeneration: string;
  providerSnapshotId: string;
  evidenceAssetIds?: string[];
  redactionStatus?: SurfaceObservationV1['redactionStatus'];
}

export interface SurfaceComputerActionDispatchV1<T> {
  providerResult: T;
  outcome: SurfaceProviderActionOutcomeV1;
}

export interface SurfaceComputerActionExecutionV1<T> {
  providerResult: T;
  surfaceResult: SurfaceActionResultV1;
  session: InteractiveSurfaceSessionV1;
  events: SurfaceExecutionEventV1[];
}

export type { BrowserSurfaceRuntimeIdentityV1, ExecuteBrowserActionInputV1, GetBrowserBindingInputV1, PrepareBrowserSessionInputV1, PrepareBrowserSessionResultV1, RecordBrowserObservationInputV1, RecordBrowserObservationResultV1, RegisterBrowserTabLeaseCleanupInputV1, SurfaceBrowserActionDispatchV1, SurfaceBrowserActionExecutionV1, SurfaceBrowserBindingResultV1, SurfaceBrowserElementInputV1, SurfaceTakeoverControlV1 } from './surfaceBrowserRuntimeTypes';

interface ComputerStateBinding {
  provider: string;
  providerStateId: string;
  subject: SurfaceGrantSubjectV1;
  surfaceStateId: string;
}

interface SurfaceExecutionRuntimeOptions {
  runRegistry?: RunRegistry;
  continuations?: SurfaceContinuationService;
}

const COMPUTER_OPERATIONS = ['list_roots', 'observe', 'act'];

/**
 * Process-local owner and control facade shared by Browser and Computer adapters.
 * Provider state remains provider-private; only scoped observations and opaque refs
 * cross this boundary.
 */
export class SurfaceExecutionRuntime {
  readonly capabilities = new SurfaceCapabilityRegistry();
  readonly sessions: SurfaceSessionManager;
  readonly grants: SurfaceAccessGrantService;
  readonly observations: SurfaceObservationRegistry;
  readonly events: SurfaceEventHub; readonly frames: SurfaceFrameRegistry; readonly outputs: SurfaceOutputRegistry;
  readonly interrupts: SurfaceInterruptService;
  readonly operations: SurfaceOperationCoordinator;
  readonly takeover: SurfaceHumanTakeoverService;
  readonly browserTabLeases: BrowserTabLeaseService;
  readonly continuations: SurfaceContinuationService;

  private readonly runRegistry: RunRegistry;
  private readonly emitters = new Map<string, (event: SurfaceExecutionEventV1) => void>();
  private readonly browserBindings = new Map<string, BrowserStateBinding>();
  private readonly computerBindings = new Map<string, ComputerStateBinding>();
  private readonly knownSubjects = new Map<string, SurfaceGrantSubjectV1>();
  private readonly eventObservers = new Set<(event: SurfaceExecutionEventV1) => void>();
  private readonly conversationControl: SurfaceConversationControlService;
  private readonly switches: SurfaceSwitchCoordinator;

  constructor(options: SurfaceExecutionRuntimeOptions = {}) {
    this.runRegistry = options.runRegistry || getApplicationRunRegistry();
    this.continuations = options.continuations || getSurfaceContinuationService();
    this.sessions = new SurfaceSessionManager({
      assertActiveOwner: (identity) => this.assertActiveRun(identity),
    });
    this.grants = new SurfaceAccessGrantService(this.sessions);
    this.browserTabLeases = new BrowserTabLeaseService(this.sessions);
    this.observations = new SurfaceObservationRegistry(this.sessions);
    this.frames = new SurfaceFrameRegistry(this.sessions); this.outputs = new SurfaceOutputRegistry(this.sessions);
    this.events = new SurfaceEventHub(this.sessions, {
      frames: this.frames,
      onEvent: (event) => {
        this.emitters.get(event.sessionId)?.(event);
        for (const observer of this.eventObservers) observer(structuredClone(event));
      },
    });
    this.switches = new SurfaceSwitchCoordinator(this.sessions, this.events);
    this.interrupts = new SurfaceInterruptService(this.sessions);
    this.operations = new SurfaceOperationCoordinator(
      this.sessions,
      this.capabilities,
      this.grants,
      this.observations,
      this.interrupts,
      this.events,
    );
    this.takeover = new SurfaceHumanTakeoverService(
      this.sessions,
      this.observations,
      this.interrupts,
      this.events,
    );
    this.conversationControl = new SurfaceConversationControlService(
      this.sessions,
      this.grants,
      this.events,
      this.interrupts,
      this.takeover,
      this.runRegistry,
      Date.now, this.outputs);
  }

  prepareBrowserSession(input: PrepareBrowserSessionInputV1): PrepareBrowserSessionResultV1 {
    const session = this.ensureBrowserSession(
      input.identity,
      input.provider || DEFAULT_BROWSER_PROVIDER,
      input.switchReason,
    );
    return { session, subject: this.subjectFor(session) };
  }

  recordBrowserObservation(
    input: RecordBrowserObservationInputV1,
  ): RecordBrowserObservationResultV1 {
    this.assertActiveRun(input.identity, 'browser', input.provider || DEFAULT_BROWSER_PROVIDER);
    const session = this.sessions.requireOwned(input.surfaceSessionId, input.identity);
    const provider = input.provider || session.provider;
    if (session.conversationId !== input.identity.conversationId
      || session.surface !== 'browser'
      || session.provider !== provider) {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_STATE_STALE',
        'Browser observation does not match the prepared Surface session.',
        'Prepare a Browser Surface session for this provider.',
        provider,
        `observe:${input.target.tabRef}`,
      );
    }
    if (![input.target.browserInstanceId, input.target.windowRef, input.target.tabRef,
      input.target.documentRevision].every((value) => typeof value === 'string' && value.trim())
      || input.elements?.some((element) => !Number.isSafeInteger(element.backendNodeId))) {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_STATE_STALE',
        'Browser observation requires opaque target refs, a document revision, and backend node ids.',
        'Capture a fresh Host-issued Browser observation.',
        provider,
        `observe:${input.target.tabRef}`,
      );
    }
    this.bindEmitter(session.sessionId, input.identity.emitSurfaceEvent);
    const subject = this.subjectFor(session);
    if (provider === RELAY_BROWSER_PROVIDER) {
      this.browserTabLeases.authorize({
        leaseId: input.leaseId || '',
        subject: this.browserLeaseSubjectFor(session),
        target: input.target,
        action: input.leaseAction || 'observe',
      });
    }
    const beforeSequence = this.events.listOwned(subject).at(-1)?.sequence || 0;
    const observation = this.observations.register({
      subject,
      target: input.target,
      providerGeneration: input.providerGeneration,
      elementRefs: (input.elements || []).map((element) => ({
        ...element,
        stateId: '',
      })),
      evidenceAssetIds: input.evidenceAssetIds || [],
      redactionStatus: input.redactionStatus || 'clean',
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
    this.browserBindings.set(
      this.browserBindingKey(input.identity, provider, session.sessionId, observation.stateId),
      { provider, subject, surfaceStateId: observation.stateId },
    );
    this.events.publish(subject, {
      phase: 'observe',
      status: 'succeeded',
      userSummary: input.userSummary || 'Observed browser tab',
      target: input.target,
      observation: { verdict: 'inconclusive', findings: [] },
      evidenceRefs: observation.evidenceAssetIds,
      artifactRefs: [],
      availableControls: ['pause', 'takeover', 'stop', 'end_session'],
      completedAt: Date.now(),
    });
    return {
      session: this.sessions.requireOwned(session.sessionId, subject),
      subject,
      observation,
      events: this.events.listOwned(subject).filter((event) => event.sequence > beforeSequence),
    };
  }

  getBrowserBinding(input: GetBrowserBindingInputV1): SurfaceBrowserBindingResultV1 | null {
    this.assertActiveRun(input.identity, 'browser', input.provider || DEFAULT_BROWSER_PROVIDER);
    const session = this.sessions.requireOwned(input.surfaceSessionId, input.identity);
    const provider = input.provider || session.provider;
    if (session.conversationId !== input.identity.conversationId
      || session.surface !== 'browser'
      || session.provider !== provider) return null;
    const binding = this.browserBindings.get(
      this.browserBindingKey(
        input.identity,
        provider,
        input.surfaceSessionId,
        input.predecessorStateId,
      ),
    );
    if (!binding) return null;
    const observation = this.observations.getOwned(binding.surfaceStateId, binding.subject);
    return observation ? { subject: binding.subject, observation } : null;
  }

  async executeBrowserAction<T>(
    input: ExecuteBrowserActionInputV1<T>,
  ): Promise<SurfaceBrowserActionExecutionV1<T>> {
    this.assertActiveRun(input.identity, 'browser', input.provider || DEFAULT_BROWSER_PROVIDER);
    const session = this.sessions.requireOwned(input.surfaceSessionId, input.identity);
    const provider = input.provider || session.provider;
    if (session.conversationId !== input.identity.conversationId
      || session.surface !== 'browser'
      || session.provider !== provider) {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_STATE_STALE',
        'Browser action does not match the prepared Surface session.',
        'Prepare and observe the Browser Surface again.',
        provider,
        input.operationId,
      );
    }
    this.assertBrowserSessionReady(session, input.operationId);
    const binding = this.browserBindings.get(
      this.browserBindingKey(
        input.identity,
        provider,
        input.surfaceSessionId,
        input.predecessorStateId,
      ),
    );
    if (!binding) {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_STATE_STALE',
        'Browser state is missing or owned by another run, agent, or Surface session.',
        'Observe the target again before the Browser action.',
        provider,
        input.operationId,
      );
    }
    const observation = this.observations.getOwned(binding.surfaceStateId, binding.subject);
    if (observation?.target.kind !== 'browser') {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_STATE_STALE',
        'Browser observation is no longer owned by this Surface session.',
        'Observe the target again before the Browser action.',
        provider,
        input.operationId,
      );
    }
    const descriptor = this.capabilities.resolve('browser_action', input.action, input.arguments);
    if (descriptor.mutation) {
      assertBrowserElementRefsOwned({
        session,
        observation,
        arguments: input.arguments,
        operationId: input.operationId,
      });
    }
    if (provider === RELAY_BROWSER_PROVIDER) {
      this.browserTabLeases.authorize({
        leaseId: input.leaseId || '',
        subject: this.browserLeaseSubjectFor(session),
        target: observation.target,
        action: input.action,
      });
    }
    const grant = this.grants.issue({
      subject: binding.subject,
      target: observation.target,
      capabilities: descriptor.capabilities,
      dataScopes: [
        `tab:${observation.target.tabRef}`,
        ...(observation.target.origin ? [`origin:${observation.target.origin}`] : []),
      ],
      actionClasses: [descriptor.actionClass],
      ttlMs: Math.min(input.deadlineMs || 60_000, 5 * 60_000),
      singleUse: descriptor.mutation,
    });
    this.bindEmitter(binding.subject.sessionId, input.identity.emitSurfaceEvent);
    const beforeSequence = this.events.listOwned(binding.subject).at(-1)?.sequence || 0;
    let providerResult: T | undefined;
    const surfaceResult = await this.operations.execute({
      subject: binding.subject,
      operationId: input.operationId,
      toolName: 'browser_action',
      action: input.action,
      arguments: input.arguments,
      target: observation.target,
      grantId: grant.grantId,
      predecessorStateId: observation.stateId,
      providerGeneration: observation.providerGeneration,
      ...(input.expectation ? { expectation: input.expectation } : {}),
      deadlineMs: input.deadlineMs || 60_000,
      ...(input.parentSignal ? { parentSignal: input.parentSignal } : {}),
      ...(input.releaseInput ? { releaseInput: input.releaseInput } : {}),
      dispatch: async (signal) => {
        const dispatched = await input.dispatch(signal, binding.subject);
        providerResult = dispatched.providerResult;
        return dispatched.outcome;
      },
    });
    if (providerResult === undefined) {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_TRANSPORT_UNAVAILABLE',
        'Browser provider returned no action result.',
        'Inspect the provider and observe the target again.',
        provider,
        input.operationId,
      );
    }
    return {
      providerResult,
      surfaceResult,
      session: this.sessions.requireOwned(binding.subject.sessionId, binding.subject),
      events: this.events.listOwned(binding.subject).filter((event) => event.sequence > beforeSequence),
    };
  }

  registerBrowserTabLeaseCleanup(input: RegisterBrowserTabLeaseCleanupInputV1): () => void {
    this.assertActiveRun(input.identity, 'browser', RELAY_BROWSER_PROVIDER);
    const session = this.sessions.requireOwned(input.surfaceSessionId, input.identity);
    if (session.conversationId !== input.identity.conversationId
      || session.surface !== 'browser'
      || session.provider !== RELAY_BROWSER_PROVIDER) {
      throw this.browserIdentityError(
        input.identity,
        'SURFACE_STATE_STALE',
        'Relay cleanup does not match the prepared Browser Surface session.',
        'Register cleanup on the owning Relay Surface session.',
        session.provider,
        `cleanup:${input.leaseId}`,
      );
    }
    const subject = this.subjectFor(session);
    const leaseSubject = this.browserLeaseSubjectFor(session);
    this.browserTabLeases.getOwned(input.leaseId, leaseSubject);
    return this.interrupts.registerCleanup(subject, async () => {
      const returnRequired = this.browserTabLeases.listReturnRequired(leaseSubject)
        .some((lease) => lease.leaseId === input.leaseId);
      if (!returnRequired) return;
      await this.browserTabLeases.returnLease({
        leaseId: input.leaseId,
        subject: leaseSubject,
        restore: input.restore,
      });
    });
  }

  prepareComputerSession(input: {
    identity: SurfaceRuntimeIdentityV1;
    provider?: string;
    switchReason?: string;
  }): { session: InteractiveSurfaceSessionV1; subject: SurfaceGrantSubjectV1 } {
    const session = this.ensureComputerSession(
      input.identity,
      input.provider || 'cua-driver',
      input.switchReason,
    );
    return { session, subject: this.subjectFor(session) };
  }

  recordComputerInputLockLifecycle(input: {
    subject: SurfaceGrantSubjectV1;
    lifecycle: CuaInputLockLifecycleEvent;
  }): SurfaceExecutionEventV1 {
    return recordComputerInputLockLifecycleEvent({
      sessions: this.sessions,
      events: this.events,
      ...input,
    });
  }

  registerCleanup(
    subject: SurfaceGrantSubjectV1,
    cleanup: () => void | Promise<void>,
  ): () => void {
    return this.interrupts.registerCleanup(subject, cleanup);
  }

  recordComputerObservation(input: {
    identity: SurfaceRuntimeIdentityV1;
    provider?: string;
    surfaceSessionId?: string;
    state: ComputerUseStateViewV1;
    metadata: SurfaceComputerStateMetadataV1;
    userSummary?: string;
  }): {
    session: InteractiveSurfaceSessionV1;
    subject: SurfaceGrantSubjectV1;
    observation: SurfaceObservationV1;
    events: SurfaceExecutionEventV1[];
  } {
    const provider = input.provider || 'cua-driver';
    const session = input.surfaceSessionId
      ? this.sessions.requireOwned(input.surfaceSessionId, input.identity)
      : this.ensureComputerSession(input.identity, provider);
    if (session.surface !== 'computer' || session.provider !== provider) {
      throw this.errorForIdentity(
        input.identity,
        'SURFACE_STATE_STALE',
        'Computer observation does not match the prepared Surface session.',
        'Prepare a Computer Surface session for this provider.',
        provider,
        `observe:${input.state.stateId}`,
      );
    }
    this.bindEmitter(session.sessionId, input.identity.emitSurfaceEvent);
    const subject = this.subjectFor(session);
    const beforeSequence = this.events.listOwned(subject).at(-1)?.sequence || 0;
    const target = computerTargetFromState(input.state, input.metadata);
    const observation = this.observations.register({
      subject,
      target,
      providerGeneration: input.metadata.providerGeneration,
      elementRefs: input.state.elements.map((element) => ({
        kind: 'computer-element' as const,
        ref: element.ref,
        stateId: '',
        windowRef: target.windowRef,
        windowRevision: target.windowRevision,
        axToken: element.ref,
        ...(element.role ? { role: element.role } : {}),
        ...(element.label ? { label: element.label } : {}),
        ...(element.frame ? { bounds: element.frame } : {}),
        ...(input.state.screenshotId ? { screenshotId: input.state.screenshotId } : {}),
      })),
      evidenceAssetIds: Array.from(new Set([
        ...(input.metadata.evidenceAssetIds || []),
        ...(input.state.screenshotId ? [input.state.screenshotId] : []),
      ])),
      redactionStatus: input.metadata.redactionStatus || 'clean',
      ttlMs: Math.max(1, input.state.expiresAtMs - Date.now()),
    });
    this.computerBindings.set(
      this.computerBindingKey(input.identity, provider, input.state.stateId),
      {
        provider,
        providerStateId: input.state.stateId,
        subject,
        surfaceStateId: observation.stateId,
      },
    );
    this.events.publish(subject, {
      phase: 'observe',
      status: 'succeeded',
      userSummary: input.userSummary || `Observed ${target.appName} window`,
      target,
      observation: {
        verdict: 'inconclusive',
        findings: input.state.degraded && input.state.degradedReason
          ? [input.state.degradedReason]
          : [],
      },
      evidenceRefs: observation.evidenceAssetIds,
      artifactRefs: [],
      availableControls: ['pause', 'takeover', 'stop', 'end_session'],
      completedAt: Date.now(),
    });
    return {
      session: this.sessions.requireOwned(session.sessionId, subject),
      subject,
      observation,
      events: this.events.listOwned(subject).filter((event) => event.sequence > beforeSequence),
    };
  }

  async executeComputerAction<T>(input: {
    identity: SurfaceRuntimeIdentityV1;
    provider?: string;
    providerStateId: string;
    operationId: string;
    arguments: Record<string, unknown>;
    expectation?: ComputerUseExpectationV1;
    parentSignal?: AbortSignal;
    deadlineMs?: number;
    releaseInput?: () => void | Promise<void>;
    dispatch(signal: AbortSignal, subject: SurfaceGrantSubjectV1): Promise<SurfaceComputerActionDispatchV1<T>>;
  }): Promise<SurfaceComputerActionExecutionV1<T>> {
    const provider = input.provider || 'cua-driver';
    this.assertActiveRun(input.identity);
    const binding = this.computerBindings.get(
      this.computerBindingKey(input.identity, provider, input.providerStateId),
    );
    if (!binding) {
      throw this.errorForIdentity(
        input.identity,
        'SURFACE_STATE_STALE',
        'Computer state is missing or owned by another run or agent.',
        'Observe the target again before sending input.',
        provider,
        input.operationId,
      );
    }
    const observation = this.observations.getOwned(binding.surfaceStateId, binding.subject);
    if (!observation) {
      throw this.errorForIdentity(
        input.identity,
        'SURFACE_STATE_STALE',
        'Computer observation is no longer owned by this Surface session.',
        'Observe the target again before sending input.',
        provider,
        input.operationId,
      );
    }
    this.bindEmitter(binding.subject.sessionId, input.identity.emitSurfaceEvent);
    const descriptor = this.capabilities.resolve('computer_use', 'act', input.arguments);
    const grant = this.grants.issue({
      subject: binding.subject,
      target: observation.target,
      capabilities: descriptor.capabilities,
      dataScopes: [`window:${observation.target.kind === 'computer' ? observation.target.windowRef : ''}`],
      actionClasses: [descriptor.actionClass],
      ttlMs: Math.min(input.deadlineMs || 60_000, 5 * 60_000),
      singleUse: true,
    });
    const beforeSequence = this.events.listOwned(binding.subject).at(-1)?.sequence || 0;
    let providerResult: T | undefined;
    const surfaceResult = await this.operations.execute({
      subject: binding.subject,
      operationId: input.operationId,
      toolName: 'computer_use',
      action: 'act',
      arguments: input.arguments,
      target: observation.target,
      grantId: grant.grantId,
      predecessorStateId: observation.stateId,
      providerGeneration: observation.providerGeneration,
      ...(input.expectation ? { expectation: computerExpectationToSurface(input.expectation) } : {}),
      deadlineMs: input.deadlineMs || 60_000,
      ...(input.parentSignal ? { parentSignal: input.parentSignal } : {}),
      releaseInput: input.releaseInput || (async () => {
        await releaseCuaLock(
          binding.subject.sessionId,
          (lifecycle) => this.recordComputerInputLockLifecycle({
            subject: binding.subject,
            lifecycle,
          }),
        );
      }),
      dispatch: async (signal) => {
        const dispatched = await input.dispatch(signal, binding.subject);
        providerResult = dispatched.providerResult;
        return dispatched.outcome;
      },
    });
    if (providerResult === undefined) {
      throw this.errorForIdentity(
        input.identity,
        'SURFACE_TRANSPORT_UNAVAILABLE',
        'Computer provider returned no action result.',
        'Inspect the provider and observe the target again.',
        provider,
        input.operationId,
      );
    }
    return {
      providerResult,
      surfaceResult,
      session: this.sessions.requireOwned(binding.subject.sessionId, binding.subject),
      events: this.events.listOwned(binding.subject).filter((event) => event.sequence > beforeSequence),
    };
  }

  getComputerBinding(input: {
    identity: SurfaceRuntimeIdentityV1;
    provider?: string;
    providerStateId: string;
  }): { subject: SurfaceGrantSubjectV1; observation: SurfaceObservationV1 } | null {
    const provider = input.provider || 'cua-driver';
    const binding = this.computerBindings.get(
      this.computerBindingKey(input.identity, provider, input.providerStateId),
    );
    if (!binding) return null;
    const observation = this.observations.getOwned(binding.surfaceStateId, binding.subject);
    return observation ? { subject: binding.subject, observation } : null;
  }

  snapshotConversation(conversationId: string): SurfaceConversationSnapshotV1 {
    return this.conversationControl.snapshotConversation(conversationId);
  }

  /** Host-only observer used by durable projections; callers receive redacted clones. */
  subscribeEvents(observer: (event: SurfaceExecutionEventV1) => void): () => void {
    this.eventObservers.add(observer);
    return () => this.eventObservers.delete(observer);
  }

  async controlConversation(input: {
    conversationId: string;
    surfaceSessionId: string;
    action: SurfaceSessionControlActionV1;
    reason?: string;
  }): Promise<SurfaceSessionControlResultV1> {
    return this.conversationControl.controlConversation(input);
  }

  async control(
    subject: SurfaceGrantSubjectV1,
    action: SurfaceSessionControlActionV1,
    options?: { reason?: string; timeoutMs?: number },
  ): Promise<void | SurfaceTakeoverControlV1> {
    if (action === 'continue') {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_POLICY_BLOCKED',
        message: 'Durable continuation must be prepared from an owned conversation checkpoint.',
        phase: 'recover',
        recommendedAction: 'Use the conversation Surface continuation control.',
        surface: 'browser',
        provider: 'surface-runtime',
        sessionId: subject.sessionId,
      });
    }
    return this.conversationControl.control(subject, action, options);
  }

  async endRun(identity: SurfaceRuntimeIdentityV1): Promise<void> {
    this.assertActiveRun(identity, 'computer', 'surface-runtime', 'cleanup');
    const subjects = Array.from(this.knownSubjects.values()).filter((subject) => {
      const session = this.sessions.get(subject.sessionId);
      return session?.conversationId === identity.conversationId && session.runId === identity.runId;
    });
    for (const subject of subjects) {
      await this.sessions.withCancellingOwnerCleanup(subject.sessionId, subject, async () => {
        const session = this.sessions.requireOwned(subject.sessionId, subject);
        if (session.state === 'completed' || session.state === 'failed') return;
        this.events.publish(subject, {
          phase: 'cleanup',
          status: 'running',
          userSummary: 'Ending Surface session and releasing control',
          ...(session.activeTarget ? { target: session.activeTarget } : {}),
          evidenceRefs: [],
          artifactRefs: [],
          availableControls: ['stop'],
        });
        try {
          this.grants.revokeForSession(subject);
          await this.conversationControl.cancelPendingTakeover(subject);
          await this.interrupts.endSession(subject);
          if (session.surface === 'computer' && session.provider === 'cua-driver') {
            await releaseCuaLock(
              subject.sessionId,
              (lifecycle) => this.recordComputerInputLockLifecycle({ subject, lifecycle }),
            );
            resetCuaBudget(subject.sessionId);
          }
          this.events.publish(subject, {
            phase: 'cleanup',
            status: 'succeeded',
            userSummary: 'Surface session ended and control was released',
            ...(session.activeTarget ? { target: session.activeTarget } : {}),
            evidenceRefs: [],
            artifactRefs: [],
            availableControls: [],
            completedAt: Date.now(),
          });
        } catch (error) {
          this.events.publish(subject, {
            phase: 'cleanup',
            status: 'failed',
            userSummary: error instanceof Error ? error.message : 'Surface cleanup failed',
            ...(session.activeTarget ? { target: session.activeTarget } : {}),
            evidenceRefs: [],
            artifactRefs: [],
            availableControls: ['end_session'],
            completedAt: Date.now(),
          });
          throw error;
        }
      });
    }
  }

  surfaceErrorFromComputerResult(input: SurfaceComputerErrorInputV1) {
    const provider = input.provider || 'cua-driver';
    return projectSurfaceComputerError(input, this.findComputerSessionId(input.identity, provider));
  }

  private ensureBrowserSession(
    identity: SurfaceRuntimeIdentityV1,
    provider: string,
    switchReason?: string,
  ): InteractiveSurfaceSessionV1 {
    this.assertActiveRun(identity, 'browser', provider);
    let session = this.sessions.findActive({
      conversationId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
      surface: 'browser',
      provider,
    });
    if (!session) {
      const switchParentSessionId = this.switches.parentSessionId(identity, 'browser');
      const continuation = switchParentSessionId ? null : this.continuations.consume(identity);
      const parentSessionId = switchParentSessionId || continuation?.parentSessionId;
      session = this.sessions.create({
        conversationId: identity.conversationId,
        runId: identity.runId,
        ...(identity.turnId ? { turnId: identity.turnId } : {}),
        agentId: identity.agentId,
        surface: 'browser',
        provider,
        ...(parentSessionId ? { parentSessionId } : {}),
        capabilities: this.capabilities.buildManifest({
          surface: 'browser',
          provider,
          protocolVersion: provider === RELAY_BROWSER_PROVIDER
            ? 'surface-execution-v1+browser-relay-v2'
            : 'surface-execution-v1+browser-managed-v2',
          operations: provider === RELAY_BROWSER_PROVIDER
            ? RELAY_BROWSER_SURFACE_OPERATIONS
            : BROWSER_SURFACE_OPERATIONS,
          observationKinds: provider === RELAY_BROWSER_PROVIDER
            ? ['dom', 'a11y', 'screenshot', 'console']
            : ['dom', 'a11y', 'screenshot', 'network', 'console'],
          supports: {
            cancel: true,
            pause: true,
            takeover: true,
            cleanup: true,
            successorObservation: true,
          },
        }),
      });
      session = this.sessions.transition(session.sessionId, this.subjectFor(session), 'running');
      if (continuation) {
        this.bindEmitter(session.sessionId, identity.emitSurfaceEvent);
        publishSurfaceContinuationEvent(this.events, session, this.subjectFor(session));
      }
    }
    this.bindEmitter(session.sessionId, identity.emitSurfaceEvent);
    this.knownSubjects.set(session.sessionId, this.subjectFor(session));
    this.switches.activate(session, identity, switchReason);
    return session;
  }

  private ensureComputerSession(
    identity: SurfaceRuntimeIdentityV1,
    provider: string,
    switchReason?: string,
  ): InteractiveSurfaceSessionV1 {
    this.assertActiveRun(identity);
    let session = this.sessions.findActive({
      conversationId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
      surface: 'computer',
      provider,
    });
    if (!session) {
      const switchParentSessionId = this.switches.parentSessionId(identity, 'computer');
      const continuation = switchParentSessionId ? null : this.continuations.consume(identity);
      const parentSessionId = switchParentSessionId || continuation?.parentSessionId;
      session = this.sessions.create({
        conversationId: identity.conversationId,
        runId: identity.runId,
        ...(identity.turnId ? { turnId: identity.turnId } : {}),
        agentId: identity.agentId,
        surface: 'computer',
        provider,
        ...(parentSessionId ? { parentSessionId } : {}),
        capabilities: this.capabilities.buildManifest({
          surface: 'computer',
          provider,
          protocolVersion: 'surface-execution-v1+cua-state-v1',
          operations: COMPUTER_OPERATIONS,
          observationKinds: ['ax', 'screenshot', 'window'],
          supports: {
            cancel: true,
            pause: true,
            takeover: true,
            cleanup: true,
            successorObservation: true,
          },
        }),
      });
      session = this.sessions.transition(session.sessionId, this.subjectFor(session), 'running');
      if (continuation) {
        this.bindEmitter(session.sessionId, identity.emitSurfaceEvent);
        publishSurfaceContinuationEvent(this.events, session, this.subjectFor(session));
      }
    }
    this.bindEmitter(session.sessionId, identity.emitSurfaceEvent);
    this.knownSubjects.set(session.sessionId, this.subjectFor(session));
    this.switches.activate(session, identity, switchReason);
    return session;
  }

  private subjectFor(session: InteractiveSurfaceSessionV1): SurfaceGrantSubjectV1 {
    return { sessionId: session.sessionId, runId: session.runId, agentId: session.agentId };
  }

  private bindEmitter(
    sessionId: string,
    emitter: SurfaceRuntimeIdentityV1['emitSurfaceEvent'],
  ): void {
    if (emitter) this.emitters.set(sessionId, emitter);
  }

  private assertActiveRun(identity: {
    conversationId: string;
    runId: string;
    agentId: string;
  }, surface: 'browser' | 'computer' = 'computer', provider = 'surface-runtime', mode: 'active' | 'cleanup' = 'active'): void {
    assertSurfaceRunOwner({
      runRegistry: this.runRegistry,
      identity,
      surface,
      provider,
      access: mode,
    });
  }

  private browserBindingKey(
    identity: SurfaceRuntimeIdentityV1,
    provider: string,
    surfaceSessionId: string,
    surfaceStateId: string,
  ): string {
    return JSON.stringify([
      identity.conversationId,
      identity.runId,
      identity.agentId,
      provider,
      surfaceSessionId,
      surfaceStateId,
    ]);
  }

  private browserLeaseSubjectFor(
    session: InteractiveSurfaceSessionV1,
  ): BrowserTabLeaseSubjectV1 {
    return {
      conversationId: session.conversationId,
      sessionId: session.sessionId,
      runId: session.runId,
      agentId: session.agentId,
    };
  }

  private findBrowserSessionId(identity: SurfaceRuntimeIdentityV1, provider: string): string {
    return this.sessions.findActive({
      conversationId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
      surface: 'browser',
      provider,
    })?.sessionId || 'unbound';
  }

  private browserIdentityError(
    identity: SurfaceRuntimeIdentityV1,
    code: 'SURFACE_STATE_STALE' | 'SURFACE_TRANSPORT_UNAVAILABLE',
    message: string,
    recommendedAction: string,
    provider: string,
    operationId: string,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: code === 'SURFACE_STATE_STALE' ? 'prepare' : 'act',
      retryable: true,
      recommendedAction,
      surface: 'browser',
      provider,
      sessionId: this.findBrowserSessionId(identity, provider),
      operationId,
    });
  }

  private assertBrowserSessionReady(
    session: InteractiveSurfaceSessionV1,
    operationId: string,
  ): void {
    if (session.state === 'running') return;
    throw new SurfaceExecutionRuntimeError({
      code: 'SURFACE_SESSION_BUSY',
      message: `Browser Surface session cannot start an operation while ${session.state}.`,
      phase: 'prepare',
      retryable: session.state === 'paused' || session.state === 'waiting_human',
      userActionRequired: session.state === 'waiting_human',
      recommendedAction: 'Resume or finish human takeover before the next Browser operation.',
      surface: 'browser',
      provider: session.provider,
      sessionId: session.sessionId,
      ...(session.activeTarget ? { targetRef: session.activeTarget } : {}),
      operationId,
    });
  }

  private computerBindingKey(
    identity: SurfaceRuntimeIdentityV1,
    provider: string,
    providerStateId: string,
  ): string {
    return JSON.stringify([
      identity.conversationId,
      identity.runId,
      identity.agentId,
      provider,
      providerStateId,
    ]);
  }

  private findComputerSessionId(identity: SurfaceRuntimeIdentityV1, provider: string): string {
    return this.sessions.findActive({
      conversationId: identity.conversationId,
      runId: identity.runId,
      agentId: identity.agentId,
      surface: 'computer',
      provider,
    })?.sessionId || 'unbound';
  }

  private errorForIdentity(
    identity: SurfaceRuntimeIdentityV1,
    code: 'SURFACE_STATE_STALE' | 'SURFACE_TRANSPORT_UNAVAILABLE',
    message: string,
    recommendedAction: string,
    provider: string,
    operationId: string,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: code === 'SURFACE_STATE_STALE' ? 'prepare' : 'act',
      retryable: true,
      recommendedAction,
      surface: 'computer',
      provider,
      sessionId: this.findComputerSessionId(identity, provider),
      operationId,
    });
  }
}

let surfaceExecutionRuntime: SurfaceExecutionRuntime | null = null;

export function getSurfaceExecutionRuntime(): SurfaceExecutionRuntime {
  surfaceExecutionRuntime ??= new SurfaceExecutionRuntime();
  return surfaceExecutionRuntime;
}

export function getConfiguredSurfaceExecutionRuntime(): SurfaceExecutionRuntime | null {
  return surfaceExecutionRuntime;
}

export function resetSurfaceExecutionRuntimeForTests(): void {
  surfaceExecutionRuntime = null;
  resetSurfaceContinuationServiceForTests();
}
