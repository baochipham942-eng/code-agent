import { createHash, randomUUID } from 'node:crypto';
import type { ToolContext, ToolExecutionResult } from '../../tools/types';
import {
  browserPool,
  getBrowserService,
} from '../infra/browserPool';
import type {
  BrowserDomSnapshot,
  BrowserService,
} from '../infra/browserService';
import type {
  SurfaceExecutionErrorV1,
  SurfaceObservationV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from './SurfaceExecutionRuntime';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

const DEFAULT_PROVIDER = 'system-chrome-cdp';
const SURFACE_PROFILE_TTL_MS = 30 * 60_000;

interface ManagedBrowserBinding {
  identity: SurfaceRuntimeIdentityV1;
  serviceKey: string;
  browserService: BrowserService;
  provider: string;
  providerGeneration: string;
  surfaceSessionId: string;
  predecessorStateId: string;
  target: Extract<SurfaceTargetRefV1, { kind: 'browser' }>;
}

export interface ManagedBrowserActionInput {
  identity: SurfaceRuntimeIdentityV1;
  operationId: string;
  action: string;
  params: Record<string, unknown>;
  abortSignal?: AbortSignal;
  executeProvider(signal: AbortSignal, browserService: BrowserService): Promise<ToolExecutionResult>;
}

function hashIdentity(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function evidenceRefsFromResult(result: ToolExecutionResult): string[] {
  const metadata = result.metadata || {};
  return Array.from(new Set([
    stringField(metadata.path),
    stringField(metadata.imagePath),
    stringField(metadata.outputPath),
  ].filter((value): value is string => Boolean(value))));
}

function artifactRefsFromResult(result: ToolExecutionResult): string[] {
  const metadata = result.metadata || {};
  const candidates = [metadata.browserArtifact, metadata.artifact];
  return Array.from(new Set(candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const id = stringField((candidate as Record<string, unknown>).artifactId)
      || stringField((candidate as Record<string, unknown>).id);
    return id ? [id] : [];
  })));
}

function domSnapshotFromResult(result: ToolExecutionResult): BrowserDomSnapshot | null {
  const candidate = result.metadata?.domSnapshot;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const snapshot = candidate as Partial<BrowserDomSnapshot>;
  if (typeof snapshot.snapshotId !== 'string'
    || typeof snapshot.tabId !== 'string'
    || typeof snapshot.capturedAtMs !== 'number'
    || typeof snapshot.url !== 'string'
    || typeof snapshot.title !== 'string'
    || !Array.isArray(snapshot.headings)
    || !Array.isArray(snapshot.interactiveElements)) return null;
  return snapshot as BrowserDomSnapshot;
}

export function surfaceIdentityFromToolContext(
  context: ToolContext,
): SurfaceRuntimeIdentityV1 | null {
  const conversationId = context.sessionId?.trim();
  const runId = context.runId?.trim();
  const agentId = context.agentId?.trim();
  if (!conversationId || !runId || !agentId) return null;
  return {
    conversationId,
    runId,
    ...(context.turnId?.trim() ? { turnId: context.turnId.trim() } : {}),
    agentId,
    ...(context.emit
      ? { emitSurfaceEvent: (event) => context.emit?.('surface_execution', event) }
      : {}),
  };
}

export function managedBrowserServiceKey(identity: SurfaceRuntimeIdentityV1): string {
  return `surface-${hashIdentity([
    identity.conversationId,
    identity.runId,
    identity.agentId,
  ])}`;
}

export class ManagedBrowserProviderAdapter {
  private readonly bindings = new Map<string, ManagedBrowserBinding>();

  constructor(
    private readonly runtime: SurfaceExecutionRuntime = getSurfaceExecutionRuntime(),
    private readonly acquireBrowser: (serviceKey: string) => BrowserService = getBrowserService,
    private readonly releaseBrowser: (serviceKey: string) => Promise<void> = (serviceKey) => (
      browserPool.releaseAgent(serviceKey)
    ),
  ) {}

  getBrowserService(identity: SurfaceRuntimeIdentityV1): BrowserService {
    return this.acquireBrowser(managedBrowserServiceKey(identity));
  }

  getBinding(identity: SurfaceRuntimeIdentityV1): Readonly<ManagedBrowserBinding> | null {
    const binding = this.bindings.get(this.ownerKey(identity));
    return binding ? { ...binding, identity: { ...binding.identity }, target: { ...binding.target } } : null;
  }

  async execute(input: ManagedBrowserActionInput): Promise<ToolExecutionResult> {
    try {
      const binding = await this.ensureBinding(input.identity);
      const descriptor = this.runtime.capabilities.resolve(
        'browser_action',
        input.action,
        input.params,
      );
      if (!descriptor.mutation) {
        const result = await this.dispatchWithAbort(binding, input);
        const providerSnapshot = input.action === 'get_dom_snapshot'
          ? domSnapshotFromResult(result)
          : null;
        if (input.action === 'get_dom_snapshot' && !providerSnapshot) {
          throw new SurfaceExecutionRuntimeError({
            code: 'SURFACE_STATE_STALE',
            message: 'Managed browser DOM snapshot did not include a Host-verifiable snapshot.',
            phase: 'observe',
            retryable: true,
            recommendedAction: 'Capture a fresh managed browser DOM snapshot before using element refs.',
            surface: 'browser',
            provider: binding.provider,
            sessionId: binding.surfaceSessionId,
            targetRef: binding.target,
            operationId: input.operationId,
          });
        }
        const observation = await this.captureObservation(binding, {
          evidenceAssetIds: evidenceRefsFromResult(result),
          userSummary: `Observed managed browser after ${input.action}`,
          ...(providerSnapshot ? { snapshot: providerSnapshot } : {}),
        });
        return this.attachSurfaceMetadata(result, binding, {
          observation: observation.observation,
          events: observation.events,
          session: observation.session,
        });
      }

      const wrapped = await this.runtime.executeBrowserAction<ToolExecutionResult>({
        identity: input.identity,
        surfaceSessionId: binding.surfaceSessionId,
        predecessorStateId: binding.predecessorStateId,
        provider: binding.provider,
        operationId: input.operationId,
        action: input.action,
        arguments: input.params,
        ...(input.abortSignal ? { parentSignal: input.abortSignal } : {}),
        dispatch: async (signal) => {
          const result = await this.dispatchWithAbort(binding, input, signal);
          let successorFailure: SurfaceExecutionErrorV1 | undefined;
          const successor = result.success && input.action !== 'close'
            ? await this.captureObservation(binding, {
                evidenceAssetIds: evidenceRefsFromResult(result),
                userSummary: `Observed managed browser after ${input.action}`,
              }).catch((error) => {
                successorFailure = this.successorObservationError(binding, input.operationId, error);
                return null;
              })
            : null;
          return {
            providerResult: result,
            outcome: {
              delivery: result.success ? 'confirmed' : 'rejected',
              verification: successorFailure ? 'inconclusive' : 'not_requested',
              overall: successorFailure
                ? 'ambiguous'
                : result.success ? 'delivered_unverified' : 'failed',
              ...(successor ? { successorObservation: successor.observation } : {}),
              evidenceRefs: evidenceRefsFromResult(result),
              artifactRefs: artifactRefsFromResult(result),
              ...(successorFailure ? { error: successorFailure } : {}),
            },
          };
        },
      });

      let session = wrapped.session;
      if (input.action === 'close') {
        await this.runtime.control(this.subject(binding), 'end_session');
        session = this.runtime.sessions.requireOwned(binding.surfaceSessionId, this.subject(binding));
        this.bindings.delete(this.ownerKey(input.identity));
      }
      return this.attachSurfaceMetadata(wrapped.providerResult, binding, {
        actionResult: wrapped.surfaceResult,
        events: wrapped.events,
        session,
      });
    } catch (error) {
      return this.failure(error);
    }
  }

  private async ensureBinding(identity: SurfaceRuntimeIdentityV1): Promise<ManagedBrowserBinding> {
    const key = this.ownerKey(identity);
    const existing = this.bindings.get(key);
    if (existing && existing.browserService.isRunning() && existing.browserService.getActiveTab()) {
      return existing;
    }

    const serviceKey = managedBrowserServiceKey(identity);
    const browserService = this.acquireBrowser(serviceKey);
    await browserService.ensureSession('about:blank', {
      profileMode: 'isolated',
      leaseOwner: `surface:${identity.runId}`,
      leaseTtlMs: SURFACE_PROFILE_TTL_MS,
    });
    const state = browserService.getSessionState();
    const provider = state.provider || DEFAULT_PROVIDER;
    const prepared = this.runtime.prepareBrowserSession({ identity, provider });
    const binding: ManagedBrowserBinding = {
      identity: { ...identity },
      serviceKey,
      browserService,
      provider,
      providerGeneration: `managed-generation:${hashIdentity([
        state.sessionId,
        state.profileId,
        provider,
      ])}`,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: '',
      target: {
        kind: 'browser',
        browserInstanceId: `managed-browser:${hashIdentity([serviceKey, state.sessionId])}`,
        windowRef: `managed-window:${hashIdentity([serviceKey])}`,
        tabRef: browserService.getActiveTab()?.id || 'unbound',
        documentRevision: 'unobserved',
      },
    };
    this.bindings.set(key, binding);
    try {
      const observed = await this.captureObservation(binding, {
        userSummary: 'Prepared an isolated managed Browser Surface session',
      });
      this.runtime.registerCleanup(prepared.subject, async () => {
        this.bindings.delete(key);
        await this.releaseBrowser(serviceKey);
      });
      binding.predecessorStateId = observed.observation.stateId;
      return binding;
    } catch (error) {
      this.bindings.delete(key);
      await this.releaseBrowser(serviceKey).catch(() => undefined);
      throw error;
    }
  }

  private async captureObservation(
    binding: ManagedBrowserBinding,
    input: { evidenceAssetIds?: string[]; userSummary: string; snapshot?: BrowserDomSnapshot },
  ) {
    const snapshot = input.snapshot || await binding.browserService.getDomSnapshot();
    const target = this.targetFromSnapshot(binding, snapshot);
    const elements = snapshot.interactiveElements.flatMap((element) => {
      const backendNodeId = element.backendNodeId ?? element.targetRef.backendNodeId;
      if (!Number.isSafeInteger(backendNodeId)) return [];
      return [{
        kind: 'browser-element' as const,
        ref: element.targetRef.refId,
        tabRef: target.tabRef,
        ...(element.targetRef.frameId ? { frameRef: element.targetRef.frameId } : {}),
        documentRevision: element.targetRef.documentRevision || target.documentRevision,
        backendNodeId: backendNodeId as number,
        ...(element.role ? { role: element.role } : {}),
        ...(element.ariaLabel || element.text
          ? { name: element.ariaLabel || element.text }
          : {}),
        bounds: element.rect,
        selectorFallback: element.selectorHint,
      }];
    });
    const recorded = this.runtime.recordBrowserObservation({
      identity: binding.identity,
      surfaceSessionId: binding.surfaceSessionId,
      provider: binding.provider,
      target,
      providerGeneration: binding.providerGeneration,
      elements,
      evidenceAssetIds: input.evidenceAssetIds || [],
      userSummary: input.userSummary,
    });
    binding.target = target;
    binding.predecessorStateId = recorded.observation.stateId;
    return recorded;
  }

  private targetFromSnapshot(
    binding: ManagedBrowserBinding,
    snapshot: BrowserDomSnapshot,
  ): Extract<SurfaceTargetRefV1, { kind: 'browser' }> {
    return {
      kind: 'browser',
      browserInstanceId: binding.target.browserInstanceId,
      windowRef: binding.target.windowRef,
      tabRef: snapshot.tabId,
      ...(originFromUrl(snapshot.url) ? { origin: originFromUrl(snapshot.url) } : {}),
      documentRevision: hashIdentity([
        binding.providerGeneration,
        snapshot.snapshotId,
        snapshot.tabId,
        snapshot.url,
      ]),
      ...(snapshot.title ? { title: snapshot.title.slice(0, 200) } : {}),
    };
  }

  private async dispatchWithAbort(
    binding: ManagedBrowserBinding,
    input: ManagedBrowserActionInput,
    runtimeSignal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const signal = runtimeSignal || input.abortSignal || new AbortController().signal;
    if (signal.aborted) throw this.cancelledError(binding, input.operationId, signal.reason);
    const closeOnAbort = () => {
      void binding.browserService.close().catch(() => undefined);
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      const result = await input.executeProvider(signal, binding.browserService);
      if (signal.aborted) throw this.cancelledError(binding, input.operationId, signal.reason);
      return result;
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
    }
  }

  private attachSurfaceMetadata(
    result: ToolExecutionResult,
    binding: ManagedBrowserBinding,
    surface: {
      session: unknown;
      events: unknown[];
      observation?: SurfaceObservationV1;
      actionResult?: unknown;
    },
  ): ToolExecutionResult {
    return {
      ...result,
      metadata: {
        ...(result.metadata || {}),
        provider: binding.provider,
        engine: 'managed',
        surfaceSessionId: binding.surfaceSessionId,
        surfaceExecutionSessionV1: surface.session,
        ...(surface.observation ? { surfaceObservationV1: surface.observation } : {}),
        ...(surface.actionResult ? { surfaceExecutionActionResultV1: surface.actionResult } : {}),
        surfaceExecutionEventsV1: surface.events,
        managedProfileMode: 'isolated',
      },
    };
  }

  private failure(error: unknown): ToolExecutionResult {
    if (error instanceof SurfaceExecutionRuntimeError) {
      return {
        success: false,
        error: error.message,
        metadata: {
          provider: error.surfaceError.provider,
          engine: 'managed',
          surfaceExecutionErrorV1: error.surfaceError,
        },
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: { provider: DEFAULT_PROVIDER, engine: 'managed' },
    };
  }

  private cancelledError(
    binding: ManagedBrowserBinding,
    operationId: string,
    reason: unknown,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code: 'SURFACE_REQUEST_CANCELLED',
      message: typeof reason === 'string' ? reason : 'Managed browser operation was cancelled.',
      phase: 'act',
      retryable: true,
      recommendedAction: 'Capture a fresh browser observation before retrying.',
      surface: 'browser',
      provider: binding.provider,
      sessionId: binding.surfaceSessionId,
      targetRef: binding.target,
      operationId,
    });
  }

  private successorObservationError(
    binding: ManagedBrowserBinding,
    operationId: string,
    cause: unknown,
  ): SurfaceExecutionErrorV1 {
    return new SurfaceExecutionRuntimeError({
      code: 'SURFACE_POSTCONDITION_FAILED',
      message: 'Managed browser mutation was delivered, but its successor state could not be observed.',
      phase: 'verify',
      retryable: true,
      recommendedAction: 'Capture a fresh observation before deciding whether to retry; do not replay the mutation automatically.',
      surface: 'browser',
      provider: binding.provider,
      sessionId: binding.surfaceSessionId,
      targetRef: binding.target,
      operationId,
      detailsSafe: {
        cause: cause instanceof Error ? cause.name : 'unknown',
      },
    }).surfaceError;
  }

  private subject(binding: ManagedBrowserBinding) {
    return {
      sessionId: binding.surfaceSessionId,
      runId: binding.identity.runId,
      agentId: binding.identity.agentId,
    };
  }

  private ownerKey(identity: SurfaceRuntimeIdentityV1): string {
    return JSON.stringify([identity.conversationId, identity.runId, identity.agentId]);
  }
}

let managedBrowserProviderAdapter: ManagedBrowserProviderAdapter | null = null;

export function getManagedBrowserProviderAdapter(): ManagedBrowserProviderAdapter {
  managedBrowserProviderAdapter ??= new ManagedBrowserProviderAdapter();
  return managedBrowserProviderAdapter;
}

export function resetManagedBrowserProviderAdapterForTests(): void {
  managedBrowserProviderAdapter = null;
}

export function createManagedBrowserOperationId(context: ToolContext, action: string): string {
  return context.currentToolCallId?.trim()
    || `managed-browser:${action}:${randomUUID()}`;
}
